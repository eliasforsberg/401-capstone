/**
 * submit-count-line Edge Function
 *
 * Records the operator's physical count for a single SKU within an active
 * count session. Computes variance = counted_quantity - snapshot_quantity.
 * If variance ≠ 0, inserts a count_correction movement into the ledger and
 * updates the stock_count_lines row.
 *
 * REQUIRED ENVIRONMENT VARIABLES (auto-set in Supabase hosted env):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * REQUEST
 *   POST /functions/v1/submit-count-line
 *   Authorization: Bearer <access_token>
 *   Content-Type: application/json
 *   Body: {
 *     session_id:        string  — UUID of the count session
 *     sku_id:            string  — UUID of the product (products.product_id)
 *     counted_quantity:  number  — physical count entered by operator
 *     idempotency_key:   string  — client-generated unique key (UUID recommended)
 *   }
 *
 * RESPONSES
 *   200  { variance: number, movement_id?: string, count_line_id: string }
 *   400  { error: string }  — validation failure
 *   401  { error: string }  — missing or invalid JWT
 *   403  { error: string }  — session does not belong to caller's business
 *   409  { error: string }  — duplicate idempotency_key
 *   500  { error: string }  — internal error
 *
 * Requirements: 6.4, 6.5
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequestBody {
  session_id: string;
  sku_id: string;
  counted_quantity: number;
  idempotency_key: string;
}

interface CountSessionRow {
  session_id: string;
  business_id: string;
  location_id: string;
  status: string;
}

interface CountLineRow {
  count_line_id: string;
  snapshot_quantity: number;
  submitted_at: string | null;
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

function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── 1. Authenticate caller ───────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Unauthorized: missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error("submit-count-line: missing required env vars");
    return json({ error: "Server configuration error" }, 500);
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
    return json({ error: "Unauthorized: invalid or expired token" }, 401);
  }

  // ── 2. Resolve caller's business_id and role ─────────────────────────────
  const { data: userRole, error: roleError } = await adminClient
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", user.id)
    .maybeSingle<{ business_id: string; role: string }>();

  if (roleError || !userRole) {
    return json({ error: "Unauthorized: user has no business role" }, 401);
  }

  const { business_id, role } = userRole;

  if (!["owner", "staff", "purchasing"].includes(role)) {
    return json({ error: "Forbidden: insufficient role to submit count lines" }, 403);
  }

  // ── 3. Parse and validate request body ──────────────────────────────────
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { session_id, sku_id, counted_quantity, idempotency_key } = body;

  if (!session_id || !isValidUUID(session_id)) {
    return json({ error: "session_id is required and must be a valid UUID" }, 400);
  }
  if (!sku_id || !isValidUUID(sku_id)) {
    return json({ error: "sku_id is required and must be a valid UUID" }, 400);
  }
  if (counted_quantity === undefined || counted_quantity === null || typeof counted_quantity !== "number") {
    return json({ error: "counted_quantity is required and must be a number" }, 400);
  }
  if (counted_quantity < 0) {
    return json({ error: "counted_quantity must be a non-negative number" }, 400);
  }
  if (!idempotency_key || typeof idempotency_key !== "string") {
    return json({ error: "idempotency_key is required" }, 400);
  }

  // ── 4. Idempotency check ─────────────────────────────────────────────────
  const { data: existingLog, error: logCheckError } = await adminClient
    .from("offline_queue_log")
    .select("log_id, status")
    .eq("idempotency_key", idempotency_key)
    .maybeSingle<{ log_id: string; status: string }>();

  if (logCheckError) {
    console.error("submit-count-line: error checking idempotency:", logCheckError.message);
    return json({ error: "Internal server error" }, 500);
  }

  if (existingLog) {
    return json(
      { error: "Duplicate request — this idempotency_key has already been processed" },
      409,
    );
  }

  // ── 5. Verify session is in_progress and belongs to caller's business ────
  const { data: session, error: sessionError } = await adminClient
    .from("stock_count_sessions")
    .select("session_id, business_id, location_id, status")
    .eq("session_id", session_id)
    .maybeSingle<CountSessionRow>();

  if (sessionError) {
    console.error("submit-count-line: error fetching session:", sessionError.message);
    return json({ error: "Internal server error" }, 500);
  }

  if (!session) {
    return json({ error: "Count session not found" }, 400);
  }

  if (session.business_id !== business_id) {
    return json({ error: "Forbidden: session does not belong to your business" }, 403);
  }

  if (session.status !== "in_progress") {
    return json(
      { error: `Cannot submit to a count session with status '${session.status}'` },
      400,
    );
  }

  // ── 6. Find the stock_count_lines row for (session_id, sku_id) ───────────
  const { data: countLine, error: lineError } = await adminClient
    .from("stock_count_lines")
    .select("count_line_id, snapshot_quantity, submitted_at")
    .eq("session_id", session_id)
    .eq("sku_id", sku_id)
    .maybeSingle<CountLineRow>();

  if (lineError) {
    console.error("submit-count-line: error fetching count line:", lineError.message);
    return json({ error: "Internal server error" }, 500);
  }

  if (!countLine) {
    return json(
      { error: "SKU is not part of this count session scope" },
      400,
    );
  }

  // ── 7. Compute variance (Requirement 6.4) ────────────────────────────────
  const snapshot_quantity = Number(countLine.snapshot_quantity);
  const variance = counted_quantity - snapshot_quantity;

  // ── 8. Create count_correction movement if variance ≠ 0 (Requirement 6.5)
  let movement_id: string | undefined;

  if (variance !== 0) {
    const { data: movement, error: movementError } = await adminClient
      .from("inventory_movements")
      .insert({
        business_id,
        location_id: session.location_id,
        sku_id,
        quantity_delta: variance,
        movement_type: "count_correction",
        reason_code: "counting_correction",
        source: "manual",
        reference_id: session_id,
        user_id: user.id,
        before_quantity: snapshot_quantity,
        after_quantity: counted_quantity,
        notes: `Count session ${session_id}: variance of ${variance > 0 ? "+" : ""}${variance}`,
      })
      .select("movement_id")
      .single<{ movement_id: string }>();

    if (movementError || !movement) {
      console.error("submit-count-line: error inserting count_correction movement:", movementError?.message);
      return json({ error: "Failed to record count correction movement" }, 500);
    }

    movement_id = movement.movement_id;
  }

  // ── 9. UPDATE stock_count_lines ──────────────────────────────────────────
  const { error: updateLineError } = await adminClient
    .from("stock_count_lines")
    .update({
      counted_quantity,
      variance,
      movement_id: movement_id ?? null,
      submitted_at: new Date().toISOString(),
      scanned_at: new Date().toISOString(),
    })
    .eq("count_line_id", countLine.count_line_id);

  if (updateLineError) {
    console.error("submit-count-line: error updating count line:", updateLineError.message);
    return json({ error: "Failed to update count line record" }, 500);
  }

  // ── 10. Record in offline_queue_log for idempotency ─────────────────────
  const { error: queueError } = await adminClient
    .from("offline_queue_log")
    .insert({
      business_id,
      idempotency_key,
      action_type: "count_line",
      payload: {
        session_id,
        sku_id,
        counted_quantity,
        variance,
        movement_id: movement_id ?? null,
        count_line_id: countLine.count_line_id,
      },
      status: "processed",
    });

  if (queueError) {
    // A unique constraint violation means concurrent request already processed it
    if (queueError.code === "23505") {
      return json({ variance, movement_id, count_line_id: countLine.count_line_id }, 200);
    }
    console.warn("submit-count-line: failed to insert offline_queue_log (non-fatal):", queueError.message);
  }

  // ── 11. Return success ───────────────────────────────────────────────────
  const responseBody: Record<string, unknown> = {
    variance,
    count_line_id: countLine.count_line_id,
  };
  if (movement_id !== undefined) {
    responseBody.movement_id = movement_id;
  }

  return json(responseBody, 200);
});
