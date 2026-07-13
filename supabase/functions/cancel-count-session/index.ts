/**
 * cancel-count-session Edge Function
 *
 * Cancels an in-progress stock count session. For every submitted count line
 * that produced a count_correction movement (variance ≠ 0), an equal and
 * opposite offsetting adjustment movement is inserted to restore the
 * inventory_balance to its pre-count state (Requirement 6.6).
 *
 * The client should display a warning to the user before calling this endpoint,
 * as cancellation rolls back all previously applied count corrections.
 *
 * REQUIRED ENVIRONMENT VARIABLES (auto-set in Supabase hosted env):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * REQUEST
 *   POST /functions/v1/cancel-count-session
 *   Authorization: Bearer <access_token>
 *   Content-Type: application/json
 *   Body: {
 *     session_id: string  — UUID of the count session to cancel
 *   }
 *
 * RESPONSES
 *   200  { cancelled: true, offset_movements_created: number, session_id: string }
 *   400  { error: string }  — validation failure / session not in_progress
 *   401  { error: string }  — missing or invalid JWT
 *   403  { error: string }  — session does not belong to caller's business
 *   500  { error: string }  — internal error
 *
 * Requirements: 6.6
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractIp, logAuditEvent } from "../_shared/audit.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequestBody {
  session_id: string;
}

interface CountSessionRow {
  session_id: string;
  business_id: string;
  location_id: string;
  status: string;
}

interface CountLineRow {
  count_line_id: string;
  sku_id: string;
  variance: number;
  movement_id: string;
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
    console.error("cancel-count-session: missing required env vars");
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
    return json({ error: "Forbidden: insufficient role to cancel a count session" }, 403);
  }

  // ── 3. Parse and validate request body ──────────────────────────────────
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { session_id } = body;

  if (!session_id || !isValidUUID(session_id)) {
    return json({ error: "session_id is required and must be a valid UUID" }, 400);
  }

  // ── 4. Verify session is in_progress and belongs to caller's business ────
  const { data: session, error: sessionError } = await adminClient
    .from("stock_count_sessions")
    .select("session_id, business_id, location_id, status")
    .eq("session_id", session_id)
    .maybeSingle<CountSessionRow>();

  if (sessionError) {
    console.error("cancel-count-session: error fetching session:", sessionError.message);
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
      { error: `Cannot cancel a count session with status '${session.status}'` },
      400,
    );
  }

  // ── 5. Find all submitted count lines (those with a movement_id set) ─────
  // These are the lines for which count_correction movements were created
  // and must now be reversed (Requirement 6.6)
  const { data: submittedLines, error: linesError } = await adminClient
    .from("stock_count_lines")
    .select("count_line_id, sku_id, variance, movement_id")
    .eq("session_id", session_id)
    .not("movement_id", "is", null);

  if (linesError) {
    console.error("cancel-count-session: error fetching submitted lines:", linesError.message);
    return json({ error: "Internal server error fetching submitted count lines" }, 500);
  }

  const lines = (submittedLines as CountLineRow[]) ?? [];
  let offset_movements_created = 0;

  // ── 6. For each submitted line, INSERT an offsetting adjustment movement ──
  // The offset restores the balance to the pre-count state.
  // quantity_delta = -variance (reverses the count_correction)
  // reason_code = 'counting_correction' (as per Requirement 1.5 correction pattern)
  for (const line of lines) {
    const variance = Number(line.variance);

    // An offset is only needed if the variance was non-zero (i.e. a movement existed)
    if (variance === 0) continue;

    const offset_delta = -variance;

    const { error: offsetError } = await adminClient
      .from("inventory_movements")
      .insert({
        business_id,
        location_id: session.location_id,
        sku_id: line.sku_id,
        quantity_delta: offset_delta,
        movement_type: "adjustment",
        reason_code: "counting_correction",
        source: "manual",
        reference_id: line.movement_id,  // links back to the original count_correction
        user_id: user.id,
        notes: `Cancelled count session ${session_id}: reversing count_correction movement ${line.movement_id}`,
      });

    if (offsetError) {
      console.error(
        `cancel-count-session: error inserting offset movement for line ${line.count_line_id}:`,
        offsetError.message,
      );
      return json({
        error: `Failed to create offset movement for SKU ${line.sku_id}. Session was NOT cancelled — please retry.`,
      }, 500);
    }

    offset_movements_created++;
  }

  // ── 7. UPDATE stock_count_sessions status to 'cancelled' ─────────────────
  const { error: updateError } = await adminClient
    .from("stock_count_sessions")
    .update({ status: "cancelled" })
    .eq("session_id", session_id);

  if (updateError) {
    console.error("cancel-count-session: error cancelling session:", updateError.message);
    return json({ error: "Failed to cancel count session" }, 500);
  }

  // ── 8. Return success ────────────────────────────────────────────────────
  // ── Audit: log count.cancelled event (fire-and-forget) ────────────────
  void logAuditEvent({
    adminClient,
    user_id: user.id,
    business_id,
    event_type: "count.cancelled",
    table_name: "stock_count_sessions",
    record_id: session_id,
    details: {
      offset_movements_created,
      location_id: session.location_id,
    },
    ip_address: extractIp(req),
  });

  return json({
    cancelled: true,
    offset_movements_created,
    session_id,
  }, 200);
});
