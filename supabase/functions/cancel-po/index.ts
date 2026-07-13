/**
 * cancel-po Edge Function
 *
 * Cancels a Purchase Order that is in `draft` or `submitted` status.
 * A PO in `partially_received` or `received` status cannot be cancelled.
 *
 * Only users with role `owner` or `purchasing` may cancel POs (Requirement 9.2).
 *
 * REQUEST
 *   POST /functions/v1/cancel-po
 *   Authorization: Bearer <user JWT>
 *   Content-Type: application/json
 *
 *   Body:
 *   {
 *     po_id: string   // UUID of the PO to cancel
 *   }
 *
 * RESPONSES
 *   200  { status: "ok", po: PurchaseOrder }
 *   400  { error: string }   — PO not in cancellable status
 *   401  { error: string }   — missing / invalid JWT
 *   403  { error: string }   — insufficient role
 *   404  { error: string }   — PO not found
 *   500  { error: string }   — unexpected server error
 *
 * REQUIREMENTS: 8.1
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

/** PO statuses from which a cancel transition is permitted (Requirement 8.1). */
const CANCELLABLE_STATUSES = ["draft", "submitted"] as const;

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
    console.error("cancel-po: missing required env vars");
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
  // 2. Role check — only owner or purchasing may cancel POs (Req 9.2)
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
      { error: "Forbidden: only owner or purchasing users may cancel purchase orders" },
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
  // 4. Fetch PO and verify ownership + cancellable status
  // ------------------------------------------------------------------
  const { data: existingPO, error: poFetchError } = await adminClient
    .from("purchase_orders")
    .select("po_id, business_id, status")
    .eq("po_id", po_id)
    .maybeSingle<{ po_id: string; business_id: string; status: string }>();

  if (poFetchError) {
    console.error("cancel-po: error fetching PO", poFetchError.message);
    return jsonResponse({ error: "Internal server error" }, 500);
  }

  if (!existingPO) {
    return jsonResponse({ error: "Purchase order not found" }, 404);
  }

  if (existingPO.business_id !== business_id) {
    return jsonResponse({ error: "Purchase order does not belong to your business" }, 403);
  }

  if (!(CANCELLABLE_STATUSES as readonly string[]).includes(existingPO.status)) {
    return jsonResponse(
      {
        error: `Cannot cancel a PO with status '${existingPO.status}'. Only draft or submitted POs can be cancelled.`,
      },
      400,
    );
  }

  // ------------------------------------------------------------------
  // 5. Transition status to 'cancelled'
  // ------------------------------------------------------------------
  const { data: updatedPO, error: updateError } = await adminClient
    .from("purchase_orders")
    .update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    .eq("po_id", po_id)
    .select()
    .single();

  if (updateError || !updatedPO) {
    console.error("cancel-po: failed to update PO status", updateError?.message);
    return jsonResponse({ error: "Failed to cancel purchase order" }, 500);
  }

  // ------------------------------------------------------------------
  // 6. Return updated PO with lines
  // ------------------------------------------------------------------
  const { data: lines } = await adminClient
    .from("purchase_order_lines")
    .select("*")
    .eq("po_id", po_id);

  return jsonResponse({
    status: "ok",
    po: { ...updatedPO, lines: lines ?? [] },
  });
});
