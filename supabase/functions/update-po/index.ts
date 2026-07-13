/**
 * update-po Edge Function
 *
 * Updates an existing Purchase Order that is still in `draft` status.
 * Supports editing header fields (notes, expected_delivery) and replacing
 * the full set of PO lines (delete-then-reinsert approach).
 *
 * Only the PO owner's business members with role `owner` or `purchasing`
 * may update a PO (Requirement 9.2).
 *
 * REQUEST
 *   POST /functions/v1/update-po
 *   Authorization: Bearer <user JWT>
 *   Content-Type: application/json
 *
 *   Body:
 *   {
 *     po_id: string,            // UUID of the PO to update
 *     updates: {
 *       notes?:             string,
 *       expected_delivery?: string,  // ISO 8601 date
 *       lines?: Array<{
 *         sku_id:           string,
 *         ordered_quantity: number,
 *         unit_cost?:       number,
 *       }>
 *     }
 *   }
 *
 * RESPONSES
 *   200  { status: "ok", po: PurchaseOrder }
 *   400  { error: string }   — validation failure / PO not in draft
 *   401  { error: string }   — missing / invalid JWT
 *   403  { error: string }   — insufficient role
 *   404  { error: string }   — PO not found
 *   500  { error: string }   — unexpected server error
 *
 * REQUIREMENTS: 8.2, 8.3
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpdatePOLine {
  sku_id: string;
  ordered_quantity: number;
  unit_cost?: number;
}

interface UpdatePOUpdates {
  notes?: string;
  expected_delivery?: string;
  lines?: UpdatePOLine[];
}

interface UpdatePORequestBody {
  po_id: string;
  updates: UpdatePOUpdates;
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
    console.error("update-po: missing required env vars");
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
  // 2. Role check — only owner or purchasing (Req 9.2)
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
      { error: "Forbidden: only owner or purchasing users may update purchase orders" },
      403,
    );
  }

  // ------------------------------------------------------------------
  // 3. Parse and validate request body
  // ------------------------------------------------------------------
  let body: UpdatePORequestBody;
  try {
    body = (await req.json()) as UpdatePORequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { po_id, updates } = body;

  if (!po_id || !isValidUUID(po_id)) {
    return jsonResponse({ error: "po_id must be a valid UUID" }, 400);
  }

  if (!updates || typeof updates !== "object") {
    return jsonResponse({ error: "updates must be an object" }, 400);
  }

  // Validate lines if provided
  if (updates.lines !== undefined) {
    if (!Array.isArray(updates.lines) || updates.lines.length === 0) {
      return jsonResponse({ error: "updates.lines must be a non-empty array when provided" }, 400);
    }

    for (let i = 0; i < updates.lines.length; i++) {
      const line = updates.lines[i];

      if (!line.sku_id || !isValidUUID(line.sku_id)) {
        return jsonResponse({ error: `updates.lines[${i}].sku_id must be a valid UUID` }, 400);
      }

      if (typeof line.ordered_quantity !== "number" || line.ordered_quantity <= 0) {
        return jsonResponse(
          { error: `updates.lines[${i}].ordered_quantity must be a positive number` },
          400,
        );
      }

      if (
        line.unit_cost !== undefined &&
        (typeof line.unit_cost !== "number" || line.unit_cost < 0)
      ) {
        return jsonResponse(
          { error: `updates.lines[${i}].unit_cost must be a non-negative number` },
          400,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // 4. Fetch PO and verify it belongs to this business and is in draft
  // ------------------------------------------------------------------
  const { data: existingPO, error: poFetchError } = await adminClient
    .from("purchase_orders")
    .select("po_id, business_id, status")
    .eq("po_id", po_id)
    .maybeSingle<{ po_id: string; business_id: string; status: string }>();

  if (poFetchError) {
    console.error("update-po: error fetching PO", poFetchError.message);
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
        error: `Cannot update a PO with status '${existingPO.status}'. Only draft POs can be edited.`,
      },
      400,
    );
  }

  // ------------------------------------------------------------------
  // 5. UPDATE purchase_orders header fields
  // ------------------------------------------------------------------
  const headerUpdates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (updates.notes !== undefined) {
    headerUpdates.notes = updates.notes;
  }

  if (updates.expected_delivery !== undefined) {
    headerUpdates.expected_delivery = updates.expected_delivery;
  }

  const { error: headerUpdateError } = await adminClient
    .from("purchase_orders")
    .update(headerUpdates)
    .eq("po_id", po_id);

  if (headerUpdateError) {
    console.error("update-po: failed to update PO header", headerUpdateError.message);
    return jsonResponse({ error: "Failed to update purchase order" }, 500);
  }

  // ------------------------------------------------------------------
  // 6. Replace lines if provided (delete existing, reinsert new)
  // ------------------------------------------------------------------
  if (updates.lines !== undefined) {
    // Delete all existing lines for this PO
    const { error: deleteError } = await adminClient
      .from("purchase_order_lines")
      .delete()
      .eq("po_id", po_id);

    if (deleteError) {
      console.error("update-po: failed to delete existing lines", deleteError.message);
      return jsonResponse({ error: "Failed to replace purchase order lines" }, 500);
    }

    // Reinsert new lines
    const lineInserts = updates.lines.map((line) => ({
      po_id,
      business_id,
      sku_id: line.sku_id,
      ordered_quantity: line.ordered_quantity,
      unit_cost: line.unit_cost ?? null,
      status: "pending",
    }));

    const { error: linesInsertError } = await adminClient
      .from("purchase_order_lines")
      .insert(lineInserts);

    if (linesInsertError) {
      console.error("update-po: failed to reinsert lines", linesInsertError.message);
      return jsonResponse({ error: "Failed to update purchase order lines" }, 500);
    }
  }

  // ------------------------------------------------------------------
  // 7. Fetch and return the updated PO with lines
  // ------------------------------------------------------------------
  const { data: updatedPO, error: refetchError } = await adminClient
    .from("purchase_orders")
    .select("*")
    .eq("po_id", po_id)
    .single();

  if (refetchError || !updatedPO) {
    console.error("update-po: failed to refetch updated PO", refetchError?.message);
    return jsonResponse({ error: "PO updated but failed to return updated record" }, 500);
  }

  const { data: updatedLines } = await adminClient
    .from("purchase_order_lines")
    .select("*")
    .eq("po_id", po_id);

  return jsonResponse({
    status: "ok",
    po: { ...updatedPO, lines: updatedLines ?? [] },
  });
});
