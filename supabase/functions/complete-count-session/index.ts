/**
 * complete-count-session Edge Function
 *
 * Finalises an in-progress stock count session. Computes the session summary
 * (total SKUs counted, total variance units, total variance value) and
 * transitions the session status to 'completed'.
 *
 * REQUIRED ENVIRONMENT VARIABLES (auto-set in Supabase hosted env):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * REQUEST
 *   POST /functions/v1/complete-count-session
 *   Authorization: Bearer <access_token>
 *   Content-Type: application/json
 *   Body: {
 *     session_id: string  — UUID of the count session to complete
 *   }
 *
 * RESPONSES
 *   200  {
 *          session_id:       string,
 *          status:           'completed',
 *          completed_at:     string,   // ISO8601
 *          total_skus:       number,
 *          total_variance:   number,   // sum of ABS(variance) for all submitted lines
 *          variance_value:   number,   // total_variance * weighted average cost_price
 *          skus_positive:    number,   // count of lines with variance > 0
 *          skus_negative:    number,   // count of lines with variance < 0
 *          skus_zero:        number,   // count of lines with variance = 0 or not submitted
 *        }
 *   400  { error: string }  — validation failure / session not in_progress
 *   401  { error: string }  — missing or invalid JWT
 *   403  { error: string }  — session does not belong to caller's business
 *   500  { error: string }  — internal error
 *
 * Requirements: 6.7
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
  sku_id: string;
  variance: number | null;
  submitted_at: string | null;
}

interface ProductCostRow {
  product_id: string;
  cost_price: number | null;
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
    console.error("complete-count-session: missing required env vars");
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
    return json({ error: "Forbidden: insufficient role to complete a count session" }, 403);
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
    console.error("complete-count-session: error fetching session:", sessionError.message);
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
      { error: `Cannot complete a count session with status '${session.status}'` },
      400,
    );
  }

  // ── 5. Fetch all count lines for the session ─────────────────────────────
  const { data: countLines, error: linesError } = await adminClient
    .from("stock_count_lines")
    .select("sku_id, variance, submitted_at")
    .eq("session_id", session_id);

  if (linesError) {
    console.error("complete-count-session: error fetching count lines:", linesError.message);
    return json({ error: "Internal server error fetching count lines" }, 500);
  }

  const lines = (countLines as CountLineRow[]) ?? [];
  const total_skus = lines.length;

  // ── 6. Fetch cost_price for all SKUs to compute variance_value ───────────
  const skuIds = lines.map((l) => l.sku_id);
  let costMap = new Map<string, number>();

  if (skuIds.length > 0) {
    const { data: products, error: productsError } = await adminClient
      .from("products")
      .select("product_id, cost_price")
      .in("product_id", skuIds);

    if (productsError) {
      console.error("complete-count-session: error fetching product costs:", productsError.message);
      return json({ error: "Internal server error fetching product costs" }, 500);
    }

    for (const p of (products as ProductCostRow[])) {
      costMap.set(p.product_id, Number(p.cost_price ?? 0));
    }
  }

  // ── 7. Compute session summary (Requirement 6.7) ─────────────────────────
  let total_variance = 0;   // sum of ABS(variance) for all submitted lines
  let variance_value = 0;   // total_variance * cost_price
  let skus_positive = 0;
  let skus_negative = 0;
  let skus_zero = 0;

  for (const line of lines) {
    if (line.submitted_at === null || line.variance === null) {
      // Not yet submitted — count as zero variance
      skus_zero++;
      continue;
    }

    const v = Number(line.variance);
    const absV = Math.abs(v);
    const cost = costMap.get(line.sku_id) ?? 0;

    total_variance += absV;
    variance_value += absV * cost;

    if (v > 0) skus_positive++;
    else if (v < 0) skus_negative++;
    else skus_zero++;
  }

  // Round to 4 decimal places to match NUMERIC(12,4) precision
  total_variance = Math.round(total_variance * 10000) / 10000;
  variance_value = Math.round(variance_value * 10000) / 10000;

  // ── 8. UPDATE stock_count_sessions ───────────────────────────────────────
  const completed_at = new Date().toISOString();

  const { error: updateError } = await adminClient
    .from("stock_count_sessions")
    .update({
      status: "completed",
      completed_at,
      total_skus,
      total_variance,
      variance_value,
    })
    .eq("session_id", session_id);

  if (updateError) {
    console.error("complete-count-session: error updating session:", updateError.message);
    return json({ error: "Failed to complete count session" }, 500);
  }

  // ── 9. Return session summary ────────────────────────────────────────────
  // ── Audit: log count.completed event (fire-and-forget) ────────────────
  void logAuditEvent({
    adminClient,
    user_id: user.id,
    business_id,
    event_type: "count.completed",
    table_name: "stock_count_sessions",
    record_id: session_id,
    details: {
      total_skus,
      total_variance,
      variance_value,
    },
    ip_address: extractIp(req),
  });

  return json({
    session_id,
    status: "completed",
    completed_at,
    total_skus,
    total_variance,
    variance_value,
    skus_positive,
    skus_negative,
    skus_zero,
  }, 200);
});
