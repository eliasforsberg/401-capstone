/**
 * adjust-stock Edge Function
 *
 * Records a manual stock adjustment for a SKU at a location. Enforces reason
 * code validation, optional notes requirement, idempotency, and an
 * owner-configurable approval threshold for staff users.
 *
 * REQUIRED ENVIRONMENT VARIABLES (auto-set in Supabase hosted env):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * REQUEST
 *   POST /functions/v1/adjust-stock
 *   Authorization: Bearer <access_token>
 *   Content-Type: application/json
 *   Body: {
 *     sku_id:           string  — UUID of the product (products.product_id)
 *     location_id:      string  — UUID of the location
 *     quantity_delta:   number  — positive = add stock, negative = remove stock
 *     reason_code:      string  — must be one of the ALLOWED_REASON_CODES
 *     notes?:           string  — optional; required when reason_code = 'other'
 *     idempotency_key:  string  — client-generated unique key (UUID recommended)
 *   }
 *
 * RESPONSES
 *   200  { movement?: MovementRow, pending?: PendingAdjustmentRow, status: 'applied' | 'pending_approval' }
 *   400  { error: string }  — validation failure
 *   401  { error: string }  — missing or invalid JWT
 *   409  { error: string }  — duplicate idempotency_key
 *   500  { error: string }  — internal error
 *
 * APPROVAL FLOW
 *   If businesses.adjustment_approval_threshold IS NOT NULL
 *   AND caller role = 'staff'
 *   AND ABS(quantity_delta) > threshold:
 *     → INSERT into inventory_adjustments_pending with status = 'pending_approval'
 *     → Do NOT insert into inventory_movements
 *     → Do NOT insert into offline_queue_log
 *   Otherwise:
 *     → INSERT into inventory_movements (movement_type = 'adjustment', source = 'manual')
 *     → INSERT into offline_queue_log (status = 'processed')
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractIp, logAuditEvent } from "../_shared/audit.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_REASON_CODES = [
  "damage",
  "spoilage",
  "theft",
  "counting_correction",
  "supplier_shortage",
  "internal_use",
  "transfer_correction",
  "other",
] as const;

type ReasonCode = typeof ALLOWED_REASON_CODES[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequestBody {
  sku_id: string;
  location_id: string;
  quantity_delta: number;
  reason_code: string;
  notes?: string;
  idempotency_key: string;
}

interface UserRoleRow {
  business_id: string;
  role: "owner" | "staff" | "purchasing" | "accountant";
}

interface InventoryBalanceRow {
  quantity: number;
}

interface BusinessRow {
  adjustment_approval_threshold: number | null;
}

interface MovementInsert {
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  movement_type: "adjustment";
  reason_code: ReasonCode;
  source: "manual";
  user_id: string;
  notes: string | null;
  before_quantity: number;
  after_quantity: number;
}

interface PendingAdjustmentInsert {
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  reason_code: ReasonCode;
  notes: string | null;
  before_quantity: number;
  after_quantity: number;
  submitted_by: string;
  status: "pending_approval";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isAllowedReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && ALLOWED_REASON_CODES.includes(value as ReasonCode);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── 1. Parse and validate request body ──────────────────────────────────
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { sku_id, location_id, quantity_delta, reason_code, notes, idempotency_key } = body;

  if (!sku_id || typeof sku_id !== "string") {
    return json({ error: "sku_id is required" }, 400);
  }
  if (!location_id || typeof location_id !== "string") {
    return json({ error: "location_id is required" }, 400);
  }
  if (quantity_delta === undefined || quantity_delta === null || typeof quantity_delta !== "number") {
    return json({ error: "quantity_delta is required and must be a number" }, 400);
  }
  if (!isAllowedReasonCode(reason_code)) {
    return json(
      { error: `reason_code must be one of: ${ALLOWED_REASON_CODES.join(", ")}` },
      400,
    );
  }
  if (!idempotency_key || typeof idempotency_key !== "string") {
    return json({ error: "idempotency_key is required" }, 400);
  }

  // Requirement 5.2: notes required when reason_code = 'other'
  if (reason_code === "other" && (!notes || notes.trim().length === 0)) {
    return json(
      { error: "notes is required and must be non-empty when reason_code is 'other'" },
      400,
    );
  }

  // ── 2. Validate caller JWT ───────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error("adjust-stock: missing required env vars");
    return json({ error: "Server configuration error" }, 500);
  }

  // Anon-key client to verify the caller's JWT
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user: caller },
    error: authError,
  } = await callerClient.auth.getUser();

  if (authError || !caller) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Service-role client for privileged DB operations
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 3. Resolve caller's business_id and role ─────────────────────────────
  const { data: callerRole, error: roleError } = await adminClient
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", caller.id)
    .maybeSingle<UserRoleRow>();

  if (roleError) {
    console.error("adjust-stock: error querying user_roles:", roleError.message);
    return json({ error: "Internal server error" }, 500);
  }

  if (!callerRole) {
    return json({ error: "Unauthorized — user has no role in any business" }, 401);
  }

  const { business_id, role } = callerRole;

  // ── 4. Idempotency check ─────────────────────────────────────────────────
  const { data: existingLog, error: logCheckError } = await adminClient
    .from("offline_queue_log")
    .select("log_id, status")
    .eq("idempotency_key", idempotency_key)
    .maybeSingle<{ log_id: string; status: string }>();

  if (logCheckError) {
    console.error("adjust-stock: error checking idempotency:", logCheckError.message);
    return json({ error: "Internal server error" }, 500);
  }

  if (existingLog) {
    return json(
      { error: "Duplicate request — this idempotency_key has already been processed" },
      409,
    );
  }

  // ── 5. Read current inventory balance (before_quantity) ─────────────────
  const { data: balanceRow, error: balanceError } = await adminClient
    .from("inventory_balances")
    .select("quantity")
    .eq("business_id", business_id)
    .eq("sku_id", sku_id)
    .eq("location_id", location_id)
    .maybeSingle<InventoryBalanceRow>();

  if (balanceError) {
    console.error("adjust-stock: error reading inventory_balances:", balanceError.message);
    return json({ error: "Internal server error" }, 500);
  }

  const before_quantity: number = balanceRow?.quantity ?? 0;
  const after_quantity: number = before_quantity + quantity_delta;

  // ── 6. Fetch approval threshold for this business ────────────────────────
  const { data: businessRow, error: businessError } = await adminClient
    .from("businesses")
    .select("adjustment_approval_threshold")
    .eq("business_id", business_id)
    .maybeSingle<BusinessRow>();

  if (businessError) {
    console.error("adjust-stock: error reading businesses:", businessError.message);
    return json({ error: "Internal server error" }, 500);
  }

  const approvalThreshold: number | null =
    businessRow?.adjustment_approval_threshold ?? null;

  // ── 7. Determine if approval is required ────────────────────────────────
  // Requirement 5.5: approval required when:
  //   - business has configured a threshold (non-null)
  //   - caller role is 'staff'
  //   - ABS(quantity_delta) > threshold
  const requiresApproval =
    approvalThreshold !== null &&
    role === "staff" &&
    Math.abs(quantity_delta) > approvalThreshold;

  // ── 8a. Approval path — insert pending record, skip movement ─────────────
  if (requiresApproval) {
    const pendingInsert: PendingAdjustmentInsert = {
      business_id,
      location_id,
      sku_id,
      quantity_delta,
      reason_code: reason_code as ReasonCode,
      notes: notes?.trim() || null,
      before_quantity,
      after_quantity,
      submitted_by: caller.id,
      status: "pending_approval",
    };

    const { data: pendingRow, error: pendingError } = await adminClient
      .from("inventory_adjustments_pending")
      .insert(pendingInsert)
      .select()
      .single();

    if (pendingError) {
      console.error("adjust-stock: error inserting pending adjustment:", pendingError.message);
      return json({ error: "Failed to create pending adjustment" }, 500);
    }

    // ── Audit: adjustment submitted for approval ──────────────────────────
    void logAuditEvent({
      adminClient,
      user_id: caller.id,
      business_id,
      event_type: "adjustment.created",
      table_name: "inventory_adjustments_pending",
      record_id: pendingRow.adjustment_id,
      details: {
        status: "pending_approval",
        reason_code,
        quantity_delta,
        sku_id,
        location_id,
      },
      ip_address: extractIp(req),
    });

    return json(
      {
        status: "pending_approval",
        pending: pendingRow,
        message: "Adjustment submitted for owner approval",
      },
      200,
    );
  }

  // ── 8b. Direct path — insert movement immediately ────────────────────────
  const movementInsert: MovementInsert = {
    business_id,
    location_id,
    sku_id,
    quantity_delta,
    movement_type: "adjustment",
    reason_code: reason_code as ReasonCode,
    source: "manual",
    user_id: caller.id,
    notes: notes?.trim() || null,
    before_quantity,
    after_quantity,
  };

  const { data: movement, error: movementError } = await adminClient
    .from("inventory_movements")
    .insert(movementInsert)
    .select()
    .single();

  if (movementError) {
    console.error("adjust-stock: error inserting movement:", movementError.message);
    return json({ error: "Failed to record adjustment movement" }, 500);
  }

  // ── 9. Record in offline_queue_log for idempotency ──────────────────────
  const { error: queueError } = await adminClient
    .from("offline_queue_log")
    .insert({
      business_id,
      idempotency_key,
      action_type: "adjustment",
      payload: {
        sku_id,
        location_id,
        quantity_delta,
        reason_code,
        notes: notes?.trim() || null,
        movement_id: movement.movement_id,
      },
      status: "processed",
    });

  if (queueError) {
    // Log warning but don't fail the request — the movement was already recorded.
    // The idempotency_key uniqueness constraint will catch any genuine duplicates.
    console.warn(
      "adjust-stock: failed to insert offline_queue_log (non-fatal):",
      queueError.message,
    );
  }

  // ── 10. Return success ───────────────────────────────────────────────────
  // ── Audit: log adjustment.created event (fire-and-forget) ─────────────
  void logAuditEvent({
    adminClient,
    user_id: caller.id,
    business_id,
    event_type: "adjustment.created",
    table_name: "inventory_movements",
    record_id: movement.movement_id,
    details: {
      status: "applied",
      reason_code,
      quantity_delta,
      sku_id,
      location_id,
    },
    ip_address: extractIp(req),
  });

  return json(
    {
      status: "applied",
      movement,
    },
    200,
  );
});
