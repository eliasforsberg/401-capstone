/**
 * submit-po Edge Function
 *
 * Transitions a Purchase Order from `draft` → `submitted`.
 * Records submitted_at and submitted_by; locks the PO from further editing
 * until explicitly reopened (not in MVP scope).
 *
 * Only users with role `owner` or `purchasing` may submit POs (Requirement 9.2).
 *
 * REQUEST
 *   POST /functions/v1/submit-po
 *   Authorization: Bearer <user JWT>
 *   Content-Type: application/json
 *
 *   Body:
 *   {
 *     po_id: string   // UUID of the PO to submit
 *   }
 *
 * RESPONSES
 *   200  { status: "ok", po: PurchaseOrder }
 *   400  { error: string }   — PO not in draft
 *   401  { error: string }   — missing / invalid JWT
 *   403  { error: string }   — insufficient role
 *   404  { error: string }   — PO not found
 *   500  { error: string }   — unexpected server error
 *
 * REQUIREMENTS: 8.1, 8.3
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractIp, logAuditEvent } from "../_shared/audit.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ------------------------------------------------------------------
  // 1. Authenticate caller
  // ------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized: missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error("submit-po: missing required env vars");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return jsonResponse({ error: "Unauthorized: invalid or expired token" }, 401);
  }

  // ------------------------------------------------------------------
  // 2. Role check — only owner or purchasing may submit POs (Req 9.2)
  // ------------------------------------------------------------------
  const { data: userRole, error: roleError } = await adminClient
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", user.id)
    .maybeSingle<{ business_id: string; role: string }>();

  if (roleError || !userRole) {
    return jsonResponse({ error: "Unauthorized: user has no business role" }, 401);
  }

  const { business_id, role } = userRole;

  if (!["owner", "purchasing"].includes(role)) {
    return jsonResponse(
      { error: "Forbidden: only owner or purchasing users may submit purchase orders" },
      403,
    );
  }

  // ------------------------------------------------------------------
  // 3. Parse and validate request body
  // ------------------------------------------------------------------
  let body: { po_id: string };
  try {
    body = (await req.json()) as { po_id: string };
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { po_id } = body;

  if (!po_id || !isValidUUID(po_id)) {
    return jsonResponse({ error: "po_id must be a valid UUID" }, 400);
  }

  // ------------------------------------------------------------------
  // 4. Fetch PO and verify ownership + draft status
  // ------------------------------------------------------------------
  const { data: existingPO, error: poFetchError } = await adminClient
    .from("purchase_orders")
    .select("po_id, business_id, status")
    .eq("po_id", po_id)
    .maybeSingle<{ po_id: string; business_id: string; status: string }>();

  if (poFetchError) {
    console.error("submit-po: error fetching PO", poFetchError.message);
    return jsonResponse({ error: "Internal server error" }, 500);
  }

  if (!existingPO) {
    return jsonResponse({ error: "Purchase order not found" }, 404);
  }

  if (existingPO.business_id !== business_id) {
    return jsonResponse({ error: "Purchase order does not belong to your business" }, 403);
  }

  if (existingPO.status !== "draft") {
    return jsonResponse(
      {
        error: `Cannot submit a PO with status '${existingPO.status}'. Only draft POs can be submitted.`,
      },
      400,
    );
  }

  // ------------------------------------------------------------------
  // 5. Transition status to 'submitted', record submitter and timestamp
  // ------------------------------------------------------------------
  const now = new Date().toISOString();

  const { data: updatedPO, error: updateError } = await adminClient
    .from("purchase_orders")
    .update({
      status: "submitted",
      submitted_at: now,
      submitted_by: user.id,
      updated_at: now,
    })
    .eq("po_id", po_id)
    .select()
    .single();

  if (updateError || !updatedPO) {
    console.error("submit-po: failed to update PO status", updateError?.message);
    return jsonResponse({ error: "Failed to submit purchase order" }, 500);
  }

  // ------------------------------------------------------------------
  // 6. Return updated PO with lines
  // ------------------------------------------------------------------
  const { data: lines } = await adminClient
    .from("purchase_order_lines")
    .select("*")
    .eq("po_id", po_id);

  // ── Audit: log po.submitted event (fire-and-forget) ───────────────────
  void logAuditEvent({
    adminClient,
    user_id: user.id,
    business_id,
    event_type: "po.submitted",
    table_name: "purchase_orders",
    record_id: po_id,
    details: { submitted_at: now },
    ip_address: extractIp(req),
  });

  return jsonResponse({
    status: "ok",
    po: { ...updatedPO, lines: lines ?? [] },
  });
});
