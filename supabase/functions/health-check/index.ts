/**
 * health-check Edge Function
 *
 * Ledger consistency health check — compares every `inventory_balances` row
 * for the caller's business against the result of `get_inventory_balance()`,
 * which sums `quantity_delta` directly from `inventory_movements`.
 *
 * Any row where `inventory_balances.quantity ≠ get_inventory_balance(sku_id, location_id)`
 * is reported as an inconsistency.
 *
 * REQUIRED ENVIRONMENT VARIABLES (auto-set in Supabase hosted env):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * REQUEST
 *   GET /functions/v1/health-check
 *   Authorization: Bearer <access_token>   (must be Owner JWT)
 *
 * RESPONSE
 *   200 {
 *         "status": "ok" | "inconsistencies_found",
 *         "checked_count": number,
 *         "inconsistencies": [
 *           {
 *             "sku_id": string,
 *             "location_id": string,
 *             "stored_balance": number,
 *             "computed_balance": number,
 *             "delta": number
 *           }
 *         ]
 *       }
 *   401 { "error": string }  — missing/invalid JWT or non-owner role
 *   500 { "error": string }  — internal error
 *
 * Requirements: 15.3
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InventoryBalanceRow {
  sku_id: string;
  location_id: string;
  quantity: number;
}

interface UserRoleRow {
  business_id: string;
  role: "owner" | "staff" | "purchasing" | "accountant";
}

interface Inconsistency {
  sku_id: string;
  location_id: string;
  stored_balance: number;
  computed_balance: number;
  delta: number;
}

interface HealthCheckResponse {
  status: "ok" | "inconsistencies_found";
  checked_count: number;
  inconsistencies: Inconsistency[];
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

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // Only allow GET (or POST for clients that can't do GET with a body)
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── 1. Validate caller JWT ───────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error("health-check: missing required env vars");
    return json({ error: "Server configuration error" }, 500);
  }

  // Anon-key client to verify the caller's JWT
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user: caller },
    error: authError,
  } = await callerClient.auth.getUser();

  if (authError || !caller) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Service-role client for privileged DB operations
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 2. Resolve caller's role — must be owner ─────────────────────────────
  const { data: callerRole, error: roleError } = await adminClient
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", caller.id)
    .maybeSingle<UserRoleRow>();

  if (roleError) {
    console.error("health-check: error querying user_roles:", roleError.message);
    return json({ error: "Internal server error" }, 500);
  }

  if (!callerRole) {
    return json({ error: "Unauthorized — user has no role in any business" }, 401);
  }

  if (callerRole.role !== "owner") {
    return json(
      { error: "Forbidden — only owners can run the ledger consistency check" },
      401,
    );
  }

  const { business_id } = callerRole;

  // ── 3. Fetch all inventory_balances rows for this business ───────────────
  const { data: balanceRows, error: balancesError } = await adminClient
    .from("inventory_balances")
    .select("sku_id, location_id, quantity")
    .eq("business_id", business_id);

  if (balancesError) {
    console.error("health-check: error querying inventory_balances:", balancesError.message);
    return json({ error: "Internal server error" }, 500);
  }

  const rows = (balanceRows ?? []) as InventoryBalanceRow[];
  const inconsistencies: Inconsistency[] = [];

  // ── 4. For each row, call get_inventory_balance() and compare ────────────
  for (const row of rows) {
    const { data: computed, error: rpcError } = await adminClient.rpc(
      "get_inventory_balance",
      { p_sku_id: row.sku_id, p_location_id: row.location_id },
    );

    if (rpcError) {
      console.error(
        `health-check: rpc error for sku=${row.sku_id} loc=${row.location_id}:`,
        rpcError.message,
      );
      // Treat RPC errors as inconsistencies rather than aborting the entire check
      inconsistencies.push({
        sku_id: row.sku_id,
        location_id: row.location_id,
        stored_balance: Number(row.quantity),
        computed_balance: -1,
        delta: NaN,
      });
      continue;
    }

    const storedBalance = Number(row.quantity);
    const computedBalance = Number(computed ?? 0);

    if (storedBalance !== computedBalance) {
      const inconsistency: Inconsistency = {
        sku_id: row.sku_id,
        location_id: row.location_id,
        stored_balance: storedBalance,
        computed_balance: computedBalance,
        delta: computedBalance - storedBalance,
      };
      inconsistencies.push(inconsistency);

      // Log every inconsistency for server-side monitoring
      console.error(
        `health-check: INCONSISTENCY detected — ` +
          `sku=${row.sku_id} loc=${row.location_id} ` +
          `stored=${storedBalance} computed=${computedBalance} ` +
          `delta=${inconsistency.delta}`,
      );
    }
  }

  // ── 5. Build and return response ─────────────────────────────────────────
  const response: HealthCheckResponse = {
    status: inconsistencies.length === 0 ? "ok" : "inconsistencies_found",
    checked_count: rows.length,
    inconsistencies,
  };

  if (inconsistencies.length > 0) {
    console.error(
      `health-check: found ${inconsistencies.length} inconsistencies out of ${rows.length} checked`,
    );
  } else {
    console.log(`health-check: all ${rows.length} balances verified — no inconsistencies`);
  }

  return json(response, 200);
});
