/**
 * reject-adjustment Edge Function
 *
 * Called by the Owner to reject a pending stock adjustment.
 *
 * BEHAVIOUR:
 *  1. Validates the caller is authenticated and has the `owner` role.
 *  2. Reads the `inventory_adjustments_pending` row by `adjustment_id`.
 *  3. Asserts the adjustment belongs to the caller's business and is still
 *     `pending_approval`.
 *  4. UPDATEs `inventory_adjustments_pending` — sets status to `rejected`,
 *     reviewed_by, and reviewed_at.
 *  5. INSERTs an alert of type `anomaly` so the submitting user sees an
 *     in-app notification about the rejection.
 *
 * NOTE: The inventory balance is NOT modified — the adjustment was never
 * applied (see Requirement 5.6).
 *
 * REQUEST BODY:
 *   { adjustment_id: string, rejection_note?: string }
 *
 * RESPONSES:
 *   200 – { success: true }
 *   400 – { error: string }
 *   401 – { error: string }
 *   403 – { error: string }
 *   404 – { error: string }
 *   500 – { error: string }
 *
 * Requirements: 5.8
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractIp, logAuditEvent } from "../_shared/audit.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RejectAdjustmentBody {
  adjustment_id: string;
  rejection_note?: string;
}

interface PendingAdjustmentRow {
  adjustment_id: string;
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  reason_code: string;
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

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Identify the caller
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Fetch the caller's role and business_id
  const { data: roleRow, error: roleError } = await adminClient
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (roleError || !roleRow) {
    return json({ error: "User has no role assignment" }, 401);
  }

  if (roleRow.role !== "owner") {
    return json({ error: "Forbidden: only owners can reject adjustments" }, 403);
  }

  const callerId = user.id;
  const callerBusinessId = roleRow.business_id as string;

  // ── Request body ──────────────────────────────────────────────────────────
  let body: RejectAdjustmentBody;
  try {
    body = (await req.json()) as RejectAdjustmentBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { adjustment_id, rejection_note } = body;
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
    console.error("reject-adjustment: fetch error:", fetchError.message);
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

  // ── Mark adjustment as rejected ───────────────────────────────────────────
  // `reviewed_by` and `reviewed_at` are the shared reviewer columns — they
  // are used for both approve and reject outcomes.
  const { error: updateError } = await adminClient
    .from("inventory_adjustments_pending")
    .update({
      status: "rejected",
      reviewed_by: callerId,
      reviewed_at: new Date().toISOString(),
      // Store the optional note in the `notes` field (appended to any existing notes)
      ...(rejection_note
        ? { notes: `[Rejection note] ${rejection_note}` }
        : {}),
    })
    .eq("adjustment_id", adjustment_id);

  if (updateError) {
    console.error("reject-adjustment: status update error:", updateError.message);
    return json({ error: "Failed to update adjustment status" }, 500);
  }

  // ── Notify the submitting user via an in-app alert ───────────────────────
  // Inserts an `anomaly` alert visible to the submitting user in-app feed.
  // The alert message describes which adjustment was rejected and includes
  // the optional rejection note from the owner.
  const noteText = rejection_note ? ` Reason: ${rejection_note}` : "";
  const deltaStr = adjustment.quantity_delta > 0
    ? `+${adjustment.quantity_delta}`
    : `${adjustment.quantity_delta}`;
  const alertMessage =
    `Your pending stock adjustment (qty delta: ${deltaStr}, reason: ${adjustment.reason_code}) was rejected by an owner.${noteText}`;

  const { error: alertError } = await adminClient
    .from("alerts")
    .insert({
      business_id: adjustment.business_id,
      location_id: adjustment.location_id,
      sku_id: adjustment.sku_id,
      alert_type: "anomaly",
      status: "active",
      message: alertMessage,
    });

  if (alertError) {
    // Alert failure is non-fatal — rejection was already persisted.
    console.warn("reject-adjustment: alert insert failed:", alertError.message);
  }

  // ── Audit: log adjustment.rejected event (fire-and-forget) ───────────────
  void logAuditEvent({
    adminClient,
    user_id: callerId,
    business_id: callerBusinessId,
    event_type: "adjustment.rejected",
    table_name: "inventory_adjustments_pending",
    record_id: adjustment_id,
    details: {
      sku_id: adjustment.sku_id,
      quantity_delta: adjustment.quantity_delta,
      reason_code: adjustment.reason_code,
      submitted_by: adjustment.submitted_by,
      rejection_note: rejection_note ?? null,
    },
    ip_address: extractIp(req),
  });

  return json({ success: true }, 200);
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
