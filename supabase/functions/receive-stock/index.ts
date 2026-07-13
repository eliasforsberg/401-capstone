/**
 * receive-stock Edge Function
 *
 * Handles stock receiving — both against a Purchase Order and ad hoc.
 * All inventory mutations flow through the append-only ledger (inventory_movements);
 * balance updates are handled atomically by the trg_update_balance DB trigger.
 *
 * REQUEST
 *   POST /functions/v1/receive-stock
 *   Authorization: Bearer <user JWT>
 *   Content-Type: application/json
 *
 *   Body:
 *   {
 *     po_id?:          string,   // UUID — omit for ad hoc receiving
 *     idempotency_key: string,   // client-generated UUID for offline-safe delivery
 *     lines: Array<{
 *       sku_id:        string,   // UUID → products.product_id
 *       location_id:   string,   // UUID → locations.location_id
 *       received_qty:  number,   // positive integer / decimal
 *       damaged_qty?:  number,   // defaults to 0
 *       unit_cost?:    number,   // used for WAC recalculation
 *     }>
 *   }
 *
 * RESPONSES
 *   200  { status: "ok",        movement_ids: string[], already_processed?: true }
 *   400  { error: string }      — validation failure
 *   401  { error: string }      — missing or invalid JWT
 *   500  { error: string }      — unexpected server error
 *
 * IDEMPOTENCY
 *   The function checks offline_queue_log for an existing entry matching the
 *   idempotency_key before doing any work.  If found with status='processed',
 *   it returns 200 immediately — safe for clients to retry after network loss.
 *
 * REQUIREMENTS
 *   2.1, 2.3, 2.4, 2.5, 2.6, 2.7
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractIp, logAuditEvent } from "../_shared/audit.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReceiveLine {
  sku_id: string;
  location_id: string;
  received_qty: number;
  damaged_qty?: number;
  unit_cost?: number;
}

interface ReceiveStockRequestBody {
  po_id?: string;
  idempotency_key: string;
  lines: ReceiveLine[];
}

interface MovementInsert {
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  movement_type: "receive" | "adjustment";
  reason_code?: string;
  source: "manual";
  reference_id?: string;
  user_id: string;
  unit_cost?: number;
  notes?: string;
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
  // 1. Authenticate caller — validate JWT and extract user identity
  // ------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized: missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error("receive-stock: missing required env vars (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY)");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  // User-scoped client — used only to verify the caller's JWT
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Service-role client — used for all DB writes that span RLS boundaries
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify the JWT and get the user record
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return jsonResponse({ error: "Unauthorized: invalid or expired token" }, 401);
  }

  // Retrieve business_id and role from user_roles (service role query — bypasses RLS)
  const { data: userRole, error: roleError } = await adminClient
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", user.id)
    .maybeSingle<{ business_id: string; role: string }>();

  if (roleError || !userRole) {
    console.error("receive-stock: failed to fetch user_roles", roleError?.message);
    return jsonResponse({ error: "Unauthorized: user has no business role" }, 401);
  }

  const { business_id, role } = userRole;

  // Only owner, staff, and purchasing roles can receive stock (Requirement 9.2)
  if (!["owner", "staff", "purchasing"].includes(role)) {
    return jsonResponse({ error: "Forbidden: insufficient role to receive stock" }, 403);
  }

  // ------------------------------------------------------------------
  // 2. Parse and validate request body
  // ------------------------------------------------------------------
  let body: ReceiveStockRequestBody;
  try {
    body = (await req.json()) as ReceiveStockRequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { po_id, idempotency_key, lines } = body;

  if (!idempotency_key || typeof idempotency_key !== "string") {
    return jsonResponse({ error: "idempotency_key is required" }, 400);
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return jsonResponse({ error: "lines must be a non-empty array" }, 400);
  }

  // Validate each line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.sku_id || !isValidUUID(line.sku_id)) {
      return jsonResponse({ error: `lines[${i}].sku_id must be a valid UUID` }, 400);
    }

    if (!line.location_id || !isValidUUID(line.location_id)) {
      return jsonResponse({ error: `lines[${i}].location_id must be a valid UUID` }, 400);
    }

    if (typeof line.received_qty !== "number" || line.received_qty <= 0) {
      return jsonResponse({
        error: `lines[${i}].received_qty must be a positive number`,
      }, 400);
    }

    const damagedQty = line.damaged_qty ?? 0;
    if (typeof damagedQty !== "number" || damagedQty < 0) {
      return jsonResponse({
        error: `lines[${i}].damaged_qty must be a non-negative number`,
      }, 400);
    }

    if (damagedQty > line.received_qty) {
      return jsonResponse({
        error: `lines[${i}].damaged_qty (${damagedQty}) cannot exceed received_qty (${line.received_qty})`,
      }, 400);
    }

    if (line.unit_cost !== undefined && (typeof line.unit_cost !== "number" || line.unit_cost < 0)) {
      return jsonResponse({
        error: `lines[${i}].unit_cost must be a non-negative number`,
      }, 400);
    }
  }

  if (po_id && !isValidUUID(po_id)) {
    return jsonResponse({ error: "po_id must be a valid UUID" }, 400);
  }

  // ------------------------------------------------------------------
  // 3. Idempotency check — return immediately if already processed
  // ------------------------------------------------------------------
  const { data: existingLog, error: logCheckError } = await adminClient
    .from("offline_queue_log")
    .select("log_id, status")
    .eq("idempotency_key", idempotency_key)
    .maybeSingle<{ log_id: string; status: string }>();

  if (logCheckError) {
    console.error("receive-stock: error checking offline_queue_log", logCheckError.message);
    return jsonResponse({ error: "Internal server error" }, 500);
  }

  if (existingLog && existingLog.status === "processed") {
    // Idempotent ACK — already processed, do nothing and return success
    return jsonResponse({ status: "ok", movement_ids: [], already_processed: true });
  }

  // ------------------------------------------------------------------
  // 4. Validate PO exists and belongs to this business (if po_id given)
  // ------------------------------------------------------------------
  if (po_id) {
    const { data: po, error: poError } = await adminClient
      .from("purchase_orders")
      .select("po_id, status, business_id")
      .eq("po_id", po_id)
      .maybeSingle<{ po_id: string; status: string; business_id: string }>();

    if (poError || !po) {
      return jsonResponse({ error: "Purchase order not found" }, 400);
    }

    if (po.business_id !== business_id) {
      return jsonResponse({ error: "Purchase order does not belong to your business" }, 403);
    }

    if (!["submitted", "partially_received"].includes(po.status)) {
      return jsonResponse({
        error: `Cannot receive against a PO with status '${po.status}'. PO must be 'submitted' or 'partially_received'.`,
      }, 400);
    }
  }

  // ------------------------------------------------------------------
  // 5. Process each receive line
  // ------------------------------------------------------------------
  const insertedMovementIds: string[] = [];

  for (const line of lines) {
    const damagedQty = line.damaged_qty ?? 0;

    // 5a. INSERT receive movement
    //     quantity_delta = received_qty (full amount including damaged — damaged will be
    //     separately subtracted via an adjustment movement per Requirement 2.5)
    const receiveMovement: MovementInsert = {
      business_id,
      location_id: line.location_id,
      sku_id: line.sku_id,
      quantity_delta: line.received_qty,
      movement_type: "receive",
      source: "manual",
      user_id: user.id,
      ...(line.unit_cost !== undefined && { unit_cost: line.unit_cost }),
      ...(po_id && { reference_id: po_id }),
    };

    const { data: receivedRow, error: receiveError } = await adminClient
      .from("inventory_movements")
      .insert(receiveMovement)
      .select("movement_id")
      .single<{ movement_id: string }>();

    if (receiveError || !receivedRow) {
      console.error("receive-stock: failed to insert receive movement", receiveError?.message);
      return jsonResponse({ error: "Failed to record receive movement" }, 500);
    }

    insertedMovementIds.push(receivedRow.movement_id);

    // 5b. INSERT damage adjustment movement (Requirement 2.5)
    //     quantity_delta = -damaged_qty so damaged stock is not added to available balance
    if (damagedQty > 0) {
      const damageMovement: MovementInsert = {
        business_id,
        location_id: line.location_id,
        sku_id: line.sku_id,
        quantity_delta: -damagedQty,
        movement_type: "adjustment",
        reason_code: "damage",
        source: "manual",
        user_id: user.id,
        reference_id: receivedRow.movement_id, // link to parent receive movement
        notes: "Damaged goods recorded at time of receiving",
      };

      const { data: damageRow, error: damageError } = await adminClient
        .from("inventory_movements")
        .insert(damageMovement)
        .select("movement_id")
        .single<{ movement_id: string }>();

      if (damageError || !damageRow) {
        console.error("receive-stock: failed to insert damage adjustment", damageError?.message);
        return jsonResponse({ error: "Failed to record damage adjustment" }, 500);
      }

      insertedMovementIds.push(damageRow.movement_id);
    }

    // 5c. Update purchase_order_lines if a PO was provided (Requirements 2.6, 2.7)
    if (po_id) {
      // Fetch the matching PO line for this SKU
      const { data: poLine, error: poLineError } = await adminClient
        .from("purchase_order_lines")
        .select("po_line_id, ordered_quantity, received_quantity")
        .eq("po_id", po_id)
        .eq("sku_id", line.sku_id)
        .maybeSingle<{
          po_line_id: string;
          ordered_quantity: number;
          received_quantity: number;
        }>();

      if (poLineError) {
        console.error("receive-stock: error fetching PO line", poLineError.message);
        return jsonResponse({ error: "Internal server error querying PO line" }, 500);
      }

      if (poLine) {
        const newReceivedQty = poLine.received_quantity + line.received_qty;
        const newLineStatus = newReceivedQty >= poLine.ordered_quantity
          ? "received"
          : "partially_received";

        const { error: lineUpdateError } = await adminClient
          .from("purchase_order_lines")
          .update({
            received_quantity: newReceivedQty,
            status: newLineStatus,
          })
          .eq("po_line_id", poLine.po_line_id);

        if (lineUpdateError) {
          console.error("receive-stock: failed to update PO line", lineUpdateError.message);
          return jsonResponse({ error: "Failed to update purchase order line" }, 500);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. Auto-set PO status to 'received' when all lines are done (Req 2.7)
  // ------------------------------------------------------------------
  if (po_id) {
    // Re-fetch all lines for this PO to check completion
    const { data: allLines, error: allLinesError } = await adminClient
      .from("purchase_order_lines")
      .select("status")
      .eq("po_id", po_id);

    if (allLinesError) {
      console.error("receive-stock: error fetching all PO lines", allLinesError.message);
      return jsonResponse({ error: "Failed to check PO completion status" }, 500);
    }

    const allReceived = allLines && allLines.length > 0 &&
      allLines.every((l: { status: string }) => l.status === "received");

    const newPoStatus = allReceived ? "received" : "partially_received";

    const { error: poUpdateError } = await adminClient
      .from("purchase_orders")
      .update({ status: newPoStatus, updated_at: new Date().toISOString() })
      .eq("po_id", po_id);

    if (poUpdateError) {
      console.error("receive-stock: failed to update PO status", poUpdateError.message);
      return jsonResponse({ error: "Failed to update purchase order status" }, 500);
    }
  }

  // ------------------------------------------------------------------
  // 7. Record in offline_queue_log for idempotency (Requirement 2.9)
  // ------------------------------------------------------------------
  const { error: logInsertError } = await adminClient
    .from("offline_queue_log")
    .insert({
      business_id,
      idempotency_key,
      action_type: "receive",
      payload: body as unknown as Record<string, unknown>,
      status: "processed",
    });

  if (logInsertError) {
    // A unique constraint violation means another concurrent request
    // already processed the same key — treat as idempotent success.
    if (logInsertError.code === "23505") {
      return jsonResponse({ status: "ok", movement_ids: insertedMovementIds, already_processed: true });
    }
    console.error("receive-stock: failed to insert offline_queue_log", logInsertError.message);
    // Non-fatal — movements are already committed; log a warning but still return success
    console.warn("receive-stock: offline_queue_log insert failed; idempotency key not recorded");
  }

  // ------------------------------------------------------------------
  // 8. Return success
  // ------------------------------------------------------------------
  // ── Audit: log inventory.movement event (fire-and-forget) ───────────────
  void logAuditEvent({
    adminClient,
    user_id: user.id,
    business_id,
    event_type: "inventory.movement",
    table_name: "inventory_movements",
    details: {
      action: "receive",
      movement_ids: insertedMovementIds,
      po_id: po_id ?? null,
      line_count: lines.length,
    },
    ip_address: extractIp(req),
  });

  return jsonResponse({ status: "ok", movement_ids: insertedMovementIds });
});
