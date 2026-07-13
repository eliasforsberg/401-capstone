/**
 * start-count-session Edge Function
 *
 * Initiates a new stock count session (cycle count or full audit) for a
 * business location. Snapshots the current inventory_balances for all
 * in-scope SKUs into stock_count_lines.snapshot_quantity.
 *
 * REQUIRED ENVIRONMENT VARIABLES (auto-set in Supabase hosted env):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * REQUEST
 *   POST /functions/v1/start-count-session
 *   Authorization: Bearer <access_token>
 *   Content-Type: application/json
 *   Body: {
 *     location_id:  string              — UUID of the location to count
 *     count_type:   'cycle_count' | 'full_audit'
 *     sku_ids?:     string[]            — required for cycle_count; ignored for full_audit
 *   }
 *
 * RESPONSES
 *   200  { session_id: string, total_skus: number }
 *   400  { error: string }  — validation failure
 *   401  { error: string }  — missing or invalid JWT
 *   403  { error: string }  — role not permitted
 *   500  { error: string }  — internal error
 *
 * Requirements: 6.1, 6.2
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractIp, logAuditEvent } from "../_shared/audit.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequestBody {
  location_id: string;
  count_type: "cycle_count" | "full_audit";
  sku_ids?: string[];
}

interface ProductRow {
  product_id: string;
}

interface InventoryBalanceRow {
  sku_id: string;
  quantity: number;
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
    console.error("start-count-session: missing required env vars");
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

  // Only owner, staff, and purchasing can perform counts (Requirement 9.2)
  if (!["owner", "staff", "purchasing"].includes(role)) {
    return json({ error: "Forbidden: insufficient role to start a count session" }, 403);
  }

  // ── 3. Parse and validate request body ──────────────────────────────────
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { location_id, count_type, sku_ids } = body;

  if (!location_id || !isValidUUID(location_id)) {
    return json({ error: "location_id is required and must be a valid UUID" }, 400);
  }

  if (count_type !== "cycle_count" && count_type !== "full_audit") {
    return json({ error: "count_type must be 'cycle_count' or 'full_audit'" }, 400);
  }

  if (count_type === "cycle_count") {
    if (!Array.isArray(sku_ids) || sku_ids.length === 0) {
      return json({ error: "sku_ids is required and must be a non-empty array for cycle_count" }, 400);
    }
    for (const id of sku_ids) {
      if (!isValidUUID(id)) {
        return json({ error: `Invalid UUID in sku_ids: ${id}` }, 400);
      }
    }
  }

  // ── 4. Verify location belongs to caller's business ──────────────────────
  const { data: location, error: locationError } = await adminClient
    .from("locations")
    .select("location_id")
    .eq("location_id", location_id)
    .eq("business_id", business_id)
    .maybeSingle<{ location_id: string }>();

  if (locationError) {
    console.error("start-count-session: error verifying location:", locationError.message);
    return json({ error: "Internal server error" }, 500);
  }

  if (!location) {
    return json({ error: "Location not found or does not belong to your business" }, 400);
  }

  // ── 5. Resolve the list of SKUs to include in the count ─────────────────
  let scopedSkuIds: string[];

  if (count_type === "full_audit") {
    // Full audit: all active products for this business (Requirement 6.1)
    const { data: products, error: productsError } = await adminClient
      .from("products")
      .select("product_id")
      .eq("business_id", business_id)
      .eq("is_active", true);

    if (productsError) {
      console.error("start-count-session: error fetching products:", productsError.message);
      return json({ error: "Internal server error fetching products" }, 500);
    }

    scopedSkuIds = (products as ProductRow[]).map((p) => p.product_id);

    if (scopedSkuIds.length === 0) {
      return json({ error: "No active products found for this business" }, 400);
    }
  } else {
    // Cycle count: use provided sku_ids — verify they belong to this business
    const { data: products, error: productsError } = await adminClient
      .from("products")
      .select("product_id")
      .eq("business_id", business_id)
      .eq("is_active", true)
      .in("product_id", sku_ids!);

    if (productsError) {
      console.error("start-count-session: error verifying SKUs:", productsError.message);
      return json({ error: "Internal server error verifying SKUs" }, 500);
    }

    const validIds = new Set((products as ProductRow[]).map((p) => p.product_id));
    const invalidIds = sku_ids!.filter((id) => !validIds.has(id));

    if (invalidIds.length > 0) {
      return json({
        error: `The following sku_ids are invalid or not active in your business: ${invalidIds.join(", ")}`,
      }, 400);
    }

    scopedSkuIds = sku_ids!;
  }

  // ── 6. Snapshot current inventory balances for scoped SKUs ──────────────
  // Requirement 6.2: snapshot at the moment the session is initiated
  const { data: balances, error: balancesError } = await adminClient
    .from("inventory_balances")
    .select("sku_id, quantity")
    .eq("business_id", business_id)
    .eq("location_id", location_id)
    .in("sku_id", scopedSkuIds);

  if (balancesError) {
    console.error("start-count-session: error fetching balances:", balancesError.message);
    return json({ error: "Internal server error fetching inventory balances" }, 500);
  }

  // Build a quick lookup: sku_id → current quantity (0 if no balance row)
  const balanceMap = new Map<string, number>();
  for (const row of (balances as InventoryBalanceRow[])) {
    balanceMap.set(row.sku_id, Number(row.quantity));
  }

  // ── 7. INSERT stock_count_sessions row ───────────────────────────────────
  const { data: session, error: sessionError } = await adminClient
    .from("stock_count_sessions")
    .insert({
      business_id,
      location_id,
      count_type,
      status: "in_progress",
      started_by: user.id,
    })
    .select("session_id")
    .single<{ session_id: string }>();

  if (sessionError || !session) {
    console.error("start-count-session: error inserting session:", sessionError?.message);
    return json({ error: "Failed to create count session" }, 500);
  }

  const { session_id } = session;

  // ── 8. INSERT stock_count_lines (one per SKU) ────────────────────────────
  const countLines = scopedSkuIds.map((sku_id) => ({
    session_id,
    business_id,
    sku_id,
    snapshot_quantity: balanceMap.get(sku_id) ?? 0,
  }));

  // Insert in batches to avoid hitting request size limits on large audits
  const BATCH_SIZE = 100;
  for (let i = 0; i < countLines.length; i += BATCH_SIZE) {
    const batch = countLines.slice(i, i + BATCH_SIZE);
    const { error: linesError } = await adminClient
      .from("stock_count_lines")
      .insert(batch);

    if (linesError) {
      console.error("start-count-session: error inserting count lines:", linesError.message);
      // Attempt to clean up the session since lines failed
      await adminClient
        .from("stock_count_sessions")
        .update({ status: "cancelled" })
        .eq("session_id", session_id);
      return json({ error: "Failed to create count session lines" }, 500);
    }
  }

  // ── 9. Return success ────────────────────────────────────────────────────
  // ── Audit: log count.started event (fire-and-forget) ──────────────────
  void logAuditEvent({
    adminClient,
    user_id: user.id,
    business_id,
    event_type: "count.started",
    table_name: "stock_count_sessions",
    record_id: session_id,
    details: {
      count_type,
      location_id,
      total_skus: scopedSkuIds.length,
    },
    ip_address: extractIp(req),
  });

  return json({
    session_id,
    total_skus: scopedSkuIds.length,
    count_type,
    status: "in_progress",
  }, 200);
});
