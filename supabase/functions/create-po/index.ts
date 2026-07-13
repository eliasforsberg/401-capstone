/**
 * create-po Edge Function
 *
 * Creates a new Purchase Order in `draft` status with one or more PO lines.
 * Only users with role `owner` or `purchasing` may create POs (Requirement 9.2).
 *
 * REQUEST
 *   POST /functions/v1/create-po
 *   Authorization: Bearer <user JWT>
 *   Content-Type: application/json
 *
 *   Body:
 *   {
 *     supplier_id:       string,   // UUID → suppliers.supplier_id
 *     location_id:       string,   // UUID → locations.location_id
 *     notes?:            string,
 *     expected_delivery?: string,  // ISO 8601 date (YYYY-MM-DD)
 *     lines: Array<{
 *       sku_id:             string,  // UUID → products.product_id
 *       ordered_quantity:   number,  // positive
 *       unit_cost?:         number,  // nullable
 *       expected_delivery?: string,  // per-line override (not stored on line, informational)
 *     }>
 *   }
 *
 * RESPONSES
 *   201  { status: "ok", po: PurchaseOrder }
 *   400  { error: string }   — validation failure
 *   401  { error: string }   — missing / invalid JWT
 *   403  { error: string }   — insufficient role
 *   500  { error: string }   — unexpected server error
 *
 * REQUIREMENTS: 8.1, 8.2
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface POLine {
  sku_id: string;
  ordered_quantity: number;
  unit_cost?: number;
  expected_delivery?: string;
}

interface CreatePORequestBody {
  supplier_id: string;
  location_id: string;
  notes?: string;
  expected_delivery?: string;
  lines: POLine[];
}

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
    console.error("create-po: missing required env vars");
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
  // 2. Role check — only owner or purchasing may create POs (Req 9.2)
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
      { error: "Forbidden: only owner or purchasing users may create purchase orders" },
      403,
    );
  }

  // ------------------------------------------------------------------
  // 3. Parse and validate request body
  // ------------------------------------------------------------------
  let body: CreatePORequestBody;
  try {
    body = (await req.json()) as CreatePORequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { supplier_id, location_id, notes, expected_delivery, lines } = body;

  if (!supplier_id || !isValidUUID(supplier_id)) {
    return jsonResponse({ error: "supplier_id must be a valid UUID" }, 400);
  }

  if (!location_id || !isValidUUID(location_id)) {
    return jsonResponse({ error: "location_id must be a valid UUID" }, 400);
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return jsonResponse({ error: "lines must be a non-empty array" }, 400);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.sku_id || !isValidUUID(line.sku_id)) {
      return jsonResponse({ error: `lines[${i}].sku_id must be a valid UUID` }, 400);
    }

    if (typeof line.ordered_quantity !== "number" || line.ordered_quantity <= 0) {
      return jsonResponse(
        { error: `lines[${i}].ordered_quantity must be a positive number` },
        400,
      );
    }

    if (
      line.unit_cost !== undefined &&
      (typeof line.unit_cost !== "number" || line.unit_cost < 0)
    ) {
      return jsonResponse(
        { error: `lines[${i}].unit_cost must be a non-negative number` },
        400,
      );
    }
  }

  // ------------------------------------------------------------------
  // 4. Verify supplier and location belong to this business
  // ------------------------------------------------------------------
  const { data: supplier, error: supplierError } = await adminClient
    .from("suppliers")
    .select("supplier_id")
    .eq("supplier_id", supplier_id)
    .eq("business_id", business_id)
    .maybeSingle<{ supplier_id: string }>();

  if (supplierError || !supplier) {
    return jsonResponse({ error: "Supplier not found or does not belong to your business" }, 400);
  }

  const { data: location, error: locationError } = await adminClient
    .from("locations")
    .select("location_id")
    .eq("location_id", location_id)
    .eq("business_id", business_id)
    .maybeSingle<{ location_id: string }>();

  if (locationError || !location) {
    return jsonResponse({ error: "Location not found or does not belong to your business" }, 400);
  }

  // ------------------------------------------------------------------
  // 5. INSERT purchase_orders row in draft status
  // ------------------------------------------------------------------
  const { data: po, error: poInsertError } = await adminClient
    .from("purchase_orders")
    .insert({
      business_id,
      location_id,
      supplier_id,
      status: "draft",
      source: "manual",
      notes: notes ?? null,
      expected_delivery: expected_delivery ?? null,
    })
    .select()
    .single();

  if (poInsertError || !po) {
    console.error("create-po: failed to insert purchase_order", poInsertError?.message);
    return jsonResponse({ error: "Failed to create purchase order" }, 500);
  }

  // ------------------------------------------------------------------
  // 6. INSERT purchase_order_lines for each line
  // ------------------------------------------------------------------
  const lineInserts = lines.map((line) => ({
    po_id: po.po_id,
    business_id,
    sku_id: line.sku_id,
    ordered_quantity: line.ordered_quantity,
    unit_cost: line.unit_cost ?? null,
    status: "pending",
  }));

  const { data: insertedLines, error: linesInsertError } = await adminClient
    .from("purchase_order_lines")
    .insert(lineInserts)
    .select();

  if (linesInsertError) {
    console.error("create-po: failed to insert purchase_order_lines", linesInsertError.message);
    // Attempt to clean up the orphaned PO header
    await adminClient.from("purchase_orders").delete().eq("po_id", po.po_id);
    return jsonResponse({ error: "Failed to create purchase order lines" }, 500);
  }

  // ------------------------------------------------------------------
  // 7. Return created PO with lines
  // ------------------------------------------------------------------
  return jsonResponse(
    {
      status: "ok",
      po: { ...po, lines: insertedLines ?? [] },
    },
    201,
  );
});
