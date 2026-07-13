/**
 * approve-adjustment Edge Function
 *
 * Called by the Owner to approve a pending stock adjustment.
 *
 * BEHAVIOUR:
 *  1. Validates the caller is authenticated and has the `owner` role.
 *  2. Reads the `inventory_adjustments_pending` row by `adjustment_id`.
 *  3. Asserts the adjustment belongs to the caller's business and is still
 *     `pending_approval`.
 *  4. INSERTs the corresponding movement into `inventory_movements` (the DB
 *     trigger handles the balance update atomically).
 *  5. UPDATEs `inventory_adjustments_pending` — sets status to `approved`,
 *     reviewed_by, reviewed_at, and movement_id.
 *
 * REQUEST BODY:
 *   { adjustment_id: string }
 *
 * RESPONSES:
 *   200 – { success: true, movement_id: string }
 *   400 – { error: string }   (invalid body, wrong status, wrong business)
 *   401 – { error: string }   (missing / invalid auth)
 *   403 – { error: string }   (caller is not an owner)
 *   404 – { error: string }   (adjustment not found)
 *   500 – { error: string }   (unexpected server error)
 *
 * Requirements: 5.7
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractIp, logAuditEvent } from "../_shared/audit.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApproveAdjustmentBody {
  adjustment_id: string;
}

interface PendingAdjustmentRow {
  adjustment_id: string;
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  reason_code: string;
  notes: string | null;
  before_quantity: number;
  after_quantity: number;
  submitted_by: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  // User-scoped client — identifies the caller
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Service-role client — used for privileged mutations after role check
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Identify the caller
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Fetch the caller's role and business_id from user_roles
  const { data: roleRow, error: roleError } = await adminClient
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (roleError || !roleRow) {
    return json({ error: "User has no role assignment" }, 401);
  }

  if (roleRow.role !== "owner") {
    return json({ error: "Forbidden: only owners can approve adjustments" }, 403);
  }

  const callerId = user.id;
  const callerBusinessId = roleRow.business_id as string;

  // ── Request body ──────────────────────────────────────────────────────────
  let body: ApproveAdjustmentBody;
  try {
    body = (await req.json()) as ApproveAdjustmentBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { adjustment_id } = body;
  if (!adjustment_id) {
    return json({ error: "adjustment_id is required" }, 400);
  }

  // ── Fetch the pending adjustment ──────────────────────────────────────────
  const { data: adjustment, error: fetchError } = await adminClient
    .from("inventory_adjustments_pending")
    .select("*")
    .eq("adjustment_id", adjustment_id)
    .maybeSingle<PendingAdjustmentRow>();

  if (fetchError) {
    console.error("approve-adjustment: fetch error:", fetchError.message);
    return json({ error: "Internal server error" }, 500);
  }

  if (!adjustment) {
    return json({ error: "Adjustment not found" }, 404);
  }

  if (adjustment.business_id !== callerBusinessId) {
    return json({ error: "Adjustment not found" }, 404);
  }

  if (adjustment.status !== "pending_approval") {
    return json(
      { error: `Adjustment is already ${adjustment.status}` },
      400,
    );
  }

  // ── Insert the inventory movement ─────────────────────────────────────────
  // The DB trigger (trg_update_balance) will atomically update inventory_balances.
  const { data: movement, error: movementError } = await adminClient
    .from("inventory_movements")
    .insert({
      business_id: adjustment.business_id,
      location_id: adjustment.location_id,
      sku_id: adjustment.sku_id,
      quantity_delta: adjustment.quantity_delta,
      movement_type: "adjustment",
      reason_code: adjustment.reason_code,
      source: "manual",
      user_id: callerId,
      notes: adjustment.notes,
      before_quantity: adjustment.before_quantity,
      after_quantity: adjustment.after_quantity,
      // Link back to the pending record via reference_id
      reference_id: adjustment.adjustment_id,
    })
    .select("movement_id")
    .single();

  if (movementError) {
    console.error("approve-adjustment: movement insert error:", movementError.message);
    return json({ error: "Failed to create inventory movement" }, 500);
  }

  // ── Mark adjustment as approved ───────────────────────────────────────────
  const { error: updateError } = await adminClient
    .from("inventory_adjustments_pending")
    .update({
      status: "approved",
      reviewed_by: callerId,
      reviewed_at: new Date().toISOString(),
      movement_id: movement.movement_id,
    })
    .eq("adjustment_id", adjustment_id);

  if (updateError) {
    console.error("approve-adjustment: status update error:", updateError.message);
    // The movement was already inserted — log but still return success so the
    // caller knows the inventory was updated. The status discrepancy can be
    // repaired by a background job.
    return json(
      {
        success: true,
        movement_id: movement.movement_id,
        warning: "Status update failed — please refresh pending adjustments list",
      },
      200,
    );
  }

  // ── Audit: log adjustment.approved event (fire-and-forget) ────────────
  void logAuditEvent({
    adminClient,
    user_id: callerId,
    business_id: callerBusinessId,
    event_type: "adjustment.approved",
    table_name: "inventory_movements",
    record_id: movement.movement_id,
    details: {
      adjustment_id,
      sku_id: adjustment.sku_id,
      quantity_delta: adjustment.quantity_delta,
    },
    ip_address: extractIp(req),
  });

  return json({ success: true, movement_id: movement.movement_id }, 200);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
