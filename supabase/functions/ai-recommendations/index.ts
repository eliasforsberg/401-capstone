/**
 * ai-recommendations Edge Function
 *
 * Scheduled hourly (Deno cron). Runs the heuristics engine and writes new
 * recommendations to the `recommendations` table.
 *
 * Heuristics implemented:
 *   1. Reorder      — projected stock at delivery <= reorder_point
 *   2. Dead Stock   — 0 sales in last 60 days with positive balance
 *   3. Count Priority — shrinkage ratio > 10 % over last 30 days
 *   4. Anomaly      — 7-day sales velocity z-score > ±3.0 vs 90-day baseline
 *
 * The function can also be triggered manually via POST with a valid JWT.
 * That lets the "Run AI Analysis" button in the mobile app invoke it on demand.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProductRow {
  product_id: string;
  sku: string;
  name: string;
  business_id: string;
  reorder_point: number;
  safety_stock: number;
  lead_time_days: number;
  is_active: boolean;
  default_supplier_id: string | null;
  // joined from suppliers
  supplier_minimum_order_qty: number | null;
  supplier_lead_time_days: number | null;
}

type RecommendationType = "reorder" | "dead_stock" | "count_priority" | "anomaly";

interface RecommendationInsert {
  business_id: string;
  recommendation_type: RecommendationType;
  sku_id: string;
  rationale_text: string;
  confidence_level: "heuristic" | "forecast";
  status: "pending";
  suggested_quantity: number | null;
}

// ---------------------------------------------------------------------------
// Supabase client (service role, so we bypass RLS)
// ---------------------------------------------------------------------------

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Helper: check for existing pending recommendation of a given type for a SKU
// ---------------------------------------------------------------------------

async function hasPendingRecommendation(
  supabase: SupabaseClient,
  businessId: string,
  skuId: string,
  type: RecommendationType,
): Promise<boolean> {
  const { count, error } = await supabase
    .from("recommendations")
    .select("recommendation_id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("sku_id", skuId)
    .eq("recommendation_type", type)
    .eq("status", "pending");

  if (error) {
    console.error(`hasPendingRecommendation error for ${skuId}:`, error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Helper: insert a recommendation (deduplication guard built in)
// ---------------------------------------------------------------------------

async function insertRecommendation(
  supabase: SupabaseClient,
  rec: RecommendationInsert,
): Promise<void> {
  const { error } = await supabase.from("recommendations").insert(rec);
  if (error) {
    console.error(
      `Failed to insert ${rec.recommendation_type} rec for sku ${rec.sku_id}:`,
      error.message,
    );
  }
}

// ---------------------------------------------------------------------------
// Helper: check if a SKU was recently rejected (suppression window = 7 days)
// ---------------------------------------------------------------------------

async function wasRecentlyRejected(
  supabase: SupabaseClient,
  businessId: string,
  skuId: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("recommendation_feedback")
    .select("feedback_id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .in("rejection_reason", ["already_ordered", "not_needed"])
    .gte("created_at", cutoff)
    // join through recommendations to filter by sku_id
    .eq("recommendations.sku_id", skuId);

  if (error) return false;
  return (count ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Heuristic 1: Reorder Recommendations
// Requirements: 11.1, 11.2, 11.3, 11.6, 11.7
// ---------------------------------------------------------------------------

async function runReorderHeuristic(
  supabase: SupabaseClient,
  businessId: string,
  products: ProductRow[],
): Promise<void> {
  for (const product of products) {
    try {
      // 1a. Current balance
      const { data: balanceRow } = await supabase
        .from("inventory_balances")
        .select("quantity")
        .eq("business_id", businessId)
        .eq("sku_id", product.product_id)
        .maybeSingle();

      const currentBalance = Number(balanceRow?.quantity ?? 0);

      // 1b. Open PO quantity (submitted POs only)
      const { data: openPoRows } = await supabase
        .from("purchase_order_lines")
        .select("ordered_quantity, received_quantity, purchase_orders!inner(status, business_id)")
        .eq("purchase_orders.business_id", businessId)
        .eq("purchase_orders.status", "submitted")
        .eq("sku_id", product.product_id);

      const openPoQty = (openPoRows ?? []).reduce(
        (sum: number, line: any) =>
          sum + Math.max(0, Number(line.ordered_quantity) - Number(line.received_quantity)),
        0,
      );

      // 1c. 30-day sales velocity
      const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: salesRows } = await supabase
        .from("inventory_movements")
        .select("quantity_delta")
        .eq("business_id", businessId)
        .eq("sku_id", product.product_id)
        .eq("movement_type", "sale")
        .gte("created_at", cutoff30);

      const totalSales30d = (salesRows ?? []).reduce(
        (sum: number, r: any) => sum + Math.abs(Number(r.quantity_delta)),
        0,
      );
      const salesVelocity30d = totalSales30d / 30; // units/day

      // 1d. Lead time (product overrides supplier)
      const leadTimeDays =
        product.lead_time_days > 0
          ? product.lead_time_days
          : (product.supplier_lead_time_days ?? 3);

      // 1e. Projected balance at delivery
      const projectedBalance =
        currentBalance + openPoQty - salesVelocity30d * leadTimeDays;

      if (projectedBalance > product.reorder_point) continue;

      // 1f. Check suppression (recent rejection)
      if (await wasRecentlyRejected(supabase, businessId, product.product_id)) continue;

      // 1g. Check for existing pending recommendation
      if (
        await hasPendingRecommendation(supabase, businessId, product.product_id, "reorder")
      ) continue;

      // 1h. Calculate suggested order quantity
      const minOrderQty = product.supplier_minimum_order_qty ?? 1;
      const rawSuggestedQty =
        salesVelocity30d * 28 +
        product.safety_stock -
        currentBalance -
        openPoQty;
      const suggestedQty = Math.max(rawSuggestedQty, minOrderQty);

      const rationale =
        `Sales velocity: ${salesVelocity30d.toFixed(1)} units/day. ` +
        `Current stock: ${currentBalance} units. ` +
        `Lead time: ${leadTimeDays} days. ` +
        `Open PO: ${openPoQty} units. ` +
        `Projected stock at delivery: ${projectedBalance.toFixed(1)} units ` +
        `(below reorder point of ${product.reorder_point}). ` +
        `Recommended order: ${Math.ceil(suggestedQty)} units to cover 4 weeks with safety buffer.`;

      await insertRecommendation(supabase, {
        business_id: businessId,
        recommendation_type: "reorder",
        sku_id: product.product_id,
        rationale_text: rationale,
        confidence_level: "heuristic",
        status: "pending",
        suggested_quantity: Math.ceil(suggestedQty),
      });
    } catch (err) {
      console.error(`Reorder heuristic error for product ${product.product_id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Heuristic 2: Dead Stock Detection
// Requirements: 11.1, 11.4
// ---------------------------------------------------------------------------

async function runDeadStockHeuristic(
  supabase: SupabaseClient,
  businessId: string,
  products: ProductRow[],
): Promise<void> {
  const cutoff60 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  for (const product of products) {
    try {
      // Check current balance
      const { data: balanceRow } = await supabase
        .from("inventory_balances")
        .select("quantity")
        .eq("business_id", businessId)
        .eq("sku_id", product.product_id)
        .maybeSingle();

      const currentBalance = Number(balanceRow?.quantity ?? 0);
      if (currentBalance <= 0) continue; // no stock to flag

      // Check for any sale in last 60 days
      const { count: saleCount } = await supabase
        .from("inventory_movements")
        .select("movement_id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("sku_id", product.product_id)
        .eq("movement_type", "sale")
        .gte("created_at", cutoff60);

      if ((saleCount ?? 0) > 0) continue; // has recent sales

      // Existing pending dead_stock check
      if (
        await hasPendingRecommendation(supabase, businessId, product.product_id, "dead_stock")
      ) continue;

      await insertRecommendation(supabase, {
        business_id: businessId,
        recommendation_type: "dead_stock",
        sku_id: product.product_id,
        rationale_text:
          `${product.name} has ${currentBalance} units in stock but no recorded sales ` +
          `in the last 60 days. Consider promotions, markdowns, or returning to supplier.`,
        confidence_level: "heuristic",
        status: "pending",
        suggested_quantity: null,
      });
    } catch (err) {
      console.error(`Dead stock heuristic error for product ${product.product_id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Heuristic 3: Count Priority
// Requirements: 11.1, 11.5
// ---------------------------------------------------------------------------

async function runCountPriorityHeuristic(
  supabase: SupabaseClient,
  businessId: string,
  products: ProductRow[],
): Promise<void> {
  const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  for (const product of products) {
    try {
      // Total shrinkage in last 30 days (damage, theft, expiry)
      const { data: shrinkageRows } = await supabase
        .from("inventory_movements")
        .select("quantity_delta")
        .eq("business_id", businessId)
        .eq("sku_id", product.product_id)
        .in("reason_code", ["theft", "damage", "expiry"])
        .gte("created_at", cutoff30);

      const shrinkage30d = (shrinkageRows ?? []).reduce(
        (sum: number, r: any) => sum + Math.abs(Number(r.quantity_delta)),
        0,
      );

      if (shrinkage30d === 0) continue;

      // Total received in last 30 days
      const { data: receiveRows } = await supabase
        .from("inventory_movements")
        .select("quantity_delta")
        .eq("business_id", businessId)
        .eq("sku_id", product.product_id)
        .eq("movement_type", "receive")
        .gte("created_at", cutoff30);

      const received30d = (receiveRows ?? []).reduce(
        (sum: number, r: any) => sum + Number(r.quantity_delta),
        0,
      );

      if (received30d <= 0) continue;

      const shrinkageRatio = shrinkage30d / received30d;
      if (shrinkageRatio <= 0.10) continue; // threshold: 10%

      if (
        await hasPendingRecommendation(supabase, businessId, product.product_id, "count_priority")
      ) continue;

      const pct = (shrinkageRatio * 100).toFixed(1);
      await insertRecommendation(supabase, {
        business_id: businessId,
        recommendation_type: "count_priority",
        sku_id: product.product_id,
        rationale_text:
          `${product.name} has a shrinkage ratio of ${pct}% over the last 30 days ` +
          `(${shrinkage30d.toFixed(1)} units lost vs ${received30d.toFixed(1)} units received). ` +
          `A physical count is recommended to verify on-hand balance.`,
        confidence_level: "heuristic",
        status: "pending",
        suggested_quantity: null,
      });
    } catch (err) {
      console.error(`Count priority heuristic error for product ${product.product_id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Heuristic 4: Anomaly Detection (Z-score on 90d daily velocity)
// Requirements: 11.1, 11.5
// ---------------------------------------------------------------------------

async function runAnomalyHeuristic(
  supabase: SupabaseClient,
  businessId: string,
  products: ProductRow[],
): Promise<void> {
  const now = Date.now();
  const cutoff90 = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const product of products) {
    try {
      // Fetch 90 days of sale movements
      const { data: salesRows90 } = await supabase
        .from("inventory_movements")
        .select("quantity_delta, created_at")
        .eq("business_id", businessId)
        .eq("sku_id", product.product_id)
        .eq("movement_type", "sale")
        .gte("created_at", cutoff90);

      if (!salesRows90 || salesRows90.length < 7) continue; // need enough data

      // Build daily totals map (key = YYYY-MM-DD)
      const dailyMap: Record<string, number> = {};
      for (const row of salesRows90) {
        const day = row.created_at.slice(0, 10);
        dailyMap[day] = (dailyMap[day] ?? 0) + Math.abs(Number(row.quantity_delta));
      }

      const dailyValues = Object.values(dailyMap);
      if (dailyValues.length < 7) continue;

      // Mean and stddev for 90d window
      const mean = dailyValues.reduce((a, b) => a + b, 0) / dailyValues.length;
      const variance =
        dailyValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / dailyValues.length;
      const stddev = Math.sqrt(variance);

      if (stddev === 0) continue; // no variation — can't compute z-score

      // 7-day average velocity
      const recent7Days = salesRows90.filter((r) => r.created_at >= cutoff7);
      const recentTotal = recent7Days.reduce(
        (sum, r) => sum + Math.abs(Number(r.quantity_delta)),
        0,
      );
      const velocity7d = recentTotal / 7;

      const zScore = (velocity7d - mean) / stddev;

      if (Math.abs(zScore) <= 3.0) continue;

      if (
        await hasPendingRecommendation(supabase, businessId, product.product_id, "anomaly")
      ) continue;

      const direction = zScore > 0 ? "surge" : "drought";
      const rationale =
        `Unusual sales ${direction} detected for ${product.name}. ` +
        `7-day average: ${velocity7d.toFixed(1)} units/day. ` +
        `90-day baseline: ${mean.toFixed(1)} ± ${stddev.toFixed(1)} units/day. ` +
        `Z-score: ${zScore.toFixed(2)}. ` +
        (zScore > 0
          ? "Stock may deplete faster than expected. Consider an early reorder."
          : "Unusually low sales — investigate possible data issue or demand change.");

      await insertRecommendation(supabase, {
        business_id: businessId,
        recommendation_type: "anomaly",
        sku_id: product.product_id,
        rationale_text: rationale,
        confidence_level: "heuristic",
        status: "pending",
        suggested_quantity: null,
      });
    } catch (err) {
      console.error(`Anomaly heuristic error for product ${product.product_id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function runAllHeuristics(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ processed: number; errors: number }> {
  // Expire old recommendations (> 30 days old, still pending)
  await supabase
    .from("recommendations")
    .update({ status: "expired" })
    .eq("business_id", businessId)
    .eq("status", "pending")
    .lt("expires_at", new Date().toISOString());

  // Fetch all active products for this business
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select(`
      product_id,
      sku,
      name,
      business_id,
      reorder_point,
      safety_stock,
      lead_time_days,
      is_active,
      default_supplier_id,
      suppliers (
        minimum_order_qty,
        lead_time_days
      )
    `)
    .eq("business_id", businessId)
    .eq("is_active", true);

  if (productsError || !products) {
    console.error("Failed to fetch products:", productsError?.message);
    return { processed: 0, errors: 1 };
  }

  // Normalize the joined supplier data
  const normalizedProducts: ProductRow[] = products.map((p: any) => ({
    product_id: p.product_id,
    sku: p.sku,
    name: p.name,
    business_id: p.business_id,
    reorder_point: Number(p.reorder_point ?? 0),
    safety_stock: Number(p.safety_stock ?? 0),
    lead_time_days: Number(p.lead_time_days ?? 0),
    is_active: p.is_active,
    default_supplier_id: p.default_supplier_id ?? null,
    supplier_minimum_order_qty: p.suppliers
      ? Number(p.suppliers.minimum_order_qty ?? 1)
      : null,
    supplier_lead_time_days: p.suppliers
      ? Number(p.suppliers.lead_time_days ?? 3)
      : null,
  }));

  console.log(
    `[ai-recommendations] Running heuristics for business ${businessId} — ${normalizedProducts.length} active products`,
  );

  await runReorderHeuristic(supabase, businessId, normalizedProducts);
  await runDeadStockHeuristic(supabase, businessId, normalizedProducts);
  await runCountPriorityHeuristic(supabase, businessId, normalizedProducts);
  await runAnomalyHeuristic(supabase, businessId, normalizedProducts);

  return { processed: normalizedProducts.length, errors: 0 };
}

// ---------------------------------------------------------------------------
// Scheduled cron entry point (hourly)
// ---------------------------------------------------------------------------

Deno.cron("ai-recommendations-hourly", "0 * * * *", async () => {
  const supabase = buildServiceClient();

  // Get all active business IDs
  const { data: businesses, error } = await supabase
    .from("businesses")
    .select("business_id");

  if (error || !businesses) {
    console.error("[ai-recommendations] Failed to fetch businesses:", error?.message);
    return;
  }

  for (const { business_id } of businesses) {
    await runAllHeuristics(supabase, business_id);
  }

  console.log(`[ai-recommendations] Scheduled run complete for ${businesses.length} businesses`);
});

// ---------------------------------------------------------------------------
// HTTP entry point — triggered manually via POST (mobile "Run AI Analysis" button)
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Authenticate caller
  const authHeader = req.headers.get("Authorization");
  const supabaseUser = buildServiceClient();
  const { data: { user }, error: authError } = await supabaseUser.auth.getUser(
    authHeader?.replace("Bearer ", "") ?? "",
  );

  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Look up the caller's business_id
  const { data: roleRow } = await supabaseUser
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!roleRow) {
    return new Response(JSON.stringify({ error: "User not registered in any business" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Only owner and purchasing may trigger manual analysis
  if (!["owner", "purchasing"].includes(roleRow.role)) {
    return new Response(JSON.stringify({ error: "Insufficient role for this action" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const serviceClient = buildServiceClient();
  const result = await runAllHeuristics(serviceClient, roleRow.business_id);

  return new Response(JSON.stringify({ ok: true, ...result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
