/**
 * square-reconcile Edge Function
 *
 * Scheduled polling reconciliation fallback (every 60 minutes).
 * If more than 60 minutes have passed since the last successful Square webhook
 * event for a business, this function queries the Square Orders API for orders
 * updated since the last sync timestamp, finds any that are missing from
 * square_sync_events, and synthesizes + processes the missing payment.completed
 * events.
 *
 * SCHEDULE
 *   Triggered every 60 minutes via Supabase cron / pg_cron / external scheduler.
 *
 * FLOW
 *   1. Find the most recent square_sync_events row with status='success' per business
 *   2. If that timestamp is > 60 min ago (or no success events exist), proceed
 *   3. Call Square Orders API: POST /v2/orders/search for orders updated since last sync
 *   4. For each order not already in square_sync_events: synthesize a payment.completed
 *      event payload and process it (insert sale movements per matched SKU)
 *   5. Insert a square_sync_events row for each synthesized event
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *   SUPABASE_URL               — auto-set in Supabase hosted env
 *   SUPABASE_SERVICE_ROLE_KEY  — auto-set in Supabase hosted env
 *   SQUARE_ACCESS_TOKEN        — Bearer token for Square API
 *   SQUARE_ENVIRONMENT         — 'sandbox' or 'production'
 *
 * Requirements: 3.9
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECONCILE_THRESHOLD_MINUTES = 60;
const SQUARE_API_BASE = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SquareOrderLineItem {
  catalog_object_id?: string;
  quantity?: string;
  name?: string;
}

interface SquareOrder {
  id: string;
  location_id: string;
  state?: string;
  line_items?: SquareOrderLineItem[];
  updated_at?: string;
  created_at?: string;
  tenders?: Array<{ id: string; type: string }>;
}

interface SquareOrdersSearchResponse {
  orders?: SquareOrder[];
  cursor?: string;
  errors?: Array<{ category: string; code: string; detail: string }>;
}

interface MovementInsert {
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  movement_type: "sale";
  source: "pos_square";
  reference_id: string;
  edge_fn_id: string;
  notes?: string;
}

interface BusinessSyncInfo {
  business_id: string;
  location_id: string;
  last_success_at: string | null;
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

function squareBaseUrl(): string {
  const env = (Deno.env.get("SQUARE_ENVIRONMENT") ?? "sandbox").toLowerCase();
  return env === "production" ? SQUARE_API_BASE.production : SQUARE_API_BASE.sandbox;
}

/**
 * Fetch orders from Square Orders API updated since a given timestamp.
 * Uses POST /v2/orders/search with a date filter.
 */
async function fetchSquareOrdersSince(
  accessToken: string,
  squareLocationId: string | null,
  sinceRfc3339: string,
): Promise<SquareOrder[]> {
  const baseUrl = squareBaseUrl();
  const url = `${baseUrl}/v2/orders/search`;

  const body: Record<string, unknown> = {
    query: {
      filter: {
        date_time_filter: {
          updated_at: {
            start_at: sinceRfc3339,
          },
        },
        state_filter: {
          // Only completed orders are relevant for inventory reconciliation
          states: ["COMPLETED"],
        },
      },
      sort: {
        sort_field: "UPDATED_AT",
        sort_order: "ASC",
      },
    },
    limit: 500,
  };

  // Optionally scope to a specific Square location
  if (squareLocationId) {
    body.location_ids = [squareLocationId];
  }

  const allOrders: SquareOrder[] = [];
  let cursor: string | undefined;

  do {
    if (cursor) {
      body.cursor = cursor;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2024-01-18",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Square Orders API returned ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as SquareOrdersSearchResponse;

    if (data.errors && data.errors.length > 0) {
      throw new Error(
        `Square API errors: ${data.errors.map((e) => `${e.code}: ${e.detail}`).join("; ")}`,
      );
    }

    if (data.orders) {
      allOrders.push(...data.orders);
    }

    cursor = data.cursor;
  } while (cursor);

  return allOrders;
}

/**
 * Process a single synthesized payment.completed event from a Square order.
 * Creates sale movements for each matched line item.
 * Returns { success, unmatchedItemIds, movementCount, errorMessage }
 */
async function processSynthesizedOrder(
  order: SquareOrder,
  businessId: string,
  locationId: string,
  eventId: string,
  adminClient: ReturnType<typeof createClient>,
): Promise<{
  success: boolean;
  unmatchedItemIds: string[];
  movementCount: number;
  errorMessage?: string;
}> {
  const lineItems = order.line_items ?? [];
  const unmatchedItemIds: string[] = [];
  const movementsToInsert: MovementInsert[] = [];

  for (const item of lineItems) {
    const catalogObjectId = item.catalog_object_id;
    const quantity = parseFloat(item.quantity ?? "1");

    if (!catalogObjectId) continue;

    // Look up product by square_catalog_item_id
    const { data: product, error: productError } = await adminClient
      .from("products")
      .select("product_id")
      .eq("business_id", businessId)
      .eq("square_catalog_item_id", catalogObjectId)
      .eq("is_active", true)
      .maybeSingle<{ product_id: string }>();

    if (productError || !product) {
      unmatchedItemIds.push(catalogObjectId);
      continue;
    }

    movementsToInsert.push({
      business_id: businessId,
      location_id: locationId,
      sku_id: product.product_id,
      quantity_delta: -quantity,
      movement_type: "sale",
      source: "pos_square",
      reference_id: eventId,
      edge_fn_id: "square-reconcile",
      notes: `Reconciled from Square order ${order.id}`,
    });
  }

  // Insert unmatched alerts
  for (const unmatchedId of unmatchedItemIds) {
    await adminClient.from("alerts").insert({
      business_id: businessId,
      location_id: locationId,
      alert_type: "square_unmatched",
      message: `Reconciliation: Square catalog item ${unmatchedId} could not be matched to a product SKU. Order ID: ${order.id}`,
    });
  }

  if (movementsToInsert.length > 0) {
    const { error: insertError } = await adminClient
      .from("inventory_movements")
      .insert(movementsToInsert);

    if (insertError) {
      return {
        success: false,
        unmatchedItemIds,
        movementCount: 0,
        errorMessage: `Failed to insert reconciliation movements: ${insertError.message}`,
      };
    }
  }

  return {
    success: true,
    unmatchedItemIds,
    movementCount: movementsToInsert.length,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const squareAccessToken = Deno.env.get("SQUARE_ACCESS_TOKEN");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("square-reconcile: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  if (!squareAccessToken) {
    console.warn("square-reconcile: SQUARE_ACCESS_TOKEN not set — skipping reconciliation");
    return jsonResponse({ status: "skipped", reason: "SQUARE_ACCESS_TOKEN not configured" });
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ------------------------------------------------------------------
  // 1. Find all active businesses with their default location
  // ------------------------------------------------------------------
  const { data: businesses, error: bizError } = await adminClient
    .from("businesses")
    .select("business_id");

  if (bizError || !businesses) {
    console.error("square-reconcile: failed to query businesses", bizError?.message);
    return jsonResponse({ error: "Failed to query businesses" }, 500);
  }

  const thresholdMs = RECONCILE_THRESHOLD_MINUTES * 60 * 1000;
  const nowMs = Date.now();

  const reconcileResults: Array<{
    business_id: string;
    outcome: "skipped_recent" | "no_square_token" | "reconciled" | "error";
    orders_synthesized?: number;
    movements_created?: number;
    error?: string;
  }> = [];

  for (const biz of businesses) {
    const businessId = biz.business_id as string;

    // ------------------------------------------------------------------
    // 2. Get default location for this business
    // ------------------------------------------------------------------
    const { data: location, error: locError } = await adminClient
      .from("locations")
      .select("location_id")
      .eq("business_id", businessId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle<{ location_id: string }>();

    if (locError || !location) {
      reconcileResults.push({
        business_id: businessId,
        outcome: "error",
        error: "No active location found",
      });
      continue;
    }

    const locationId = location.location_id;

    // ------------------------------------------------------------------
    // 3. Find the most recent successful square_sync_events for this business
    // ------------------------------------------------------------------
    const { data: lastSuccess, error: lastSuccessError } = await adminClient
      .from("square_sync_events")
      .select("event_id, processed_at, created_at")
      .eq("business_id", businessId)
      .eq("status", "success")
      .order("processed_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ event_id: string; processed_at: string | null; created_at: string }>();

    if (lastSuccessError) {
      console.error(
        `square-reconcile: error querying last success for business ${businessId}:`,
        lastSuccessError.message,
      );
      reconcileResults.push({
        business_id: businessId,
        outcome: "error",
        error: lastSuccessError.message,
      });
      continue;
    }

    // Determine how long ago the last successful sync was
    let lastSyncTimestamp: Date | null = null;
    if (lastSuccess?.processed_at) {
      lastSyncTimestamp = new Date(lastSuccess.processed_at);
    } else if (lastSuccess?.created_at) {
      lastSyncTimestamp = new Date(lastSuccess.created_at);
    }

    const timeSinceLastSuccessMs = lastSyncTimestamp
      ? nowMs - lastSyncTimestamp.getTime()
      : Infinity;

    // ------------------------------------------------------------------
    // 4. Skip if last success was within the threshold window
    // ------------------------------------------------------------------
    if (timeSinceLastSuccessMs < thresholdMs) {
      reconcileResults.push({ business_id: businessId, outcome: "skipped_recent" });
      continue;
    }

    console.log(
      `square-reconcile: business ${businessId} last synced ${Math.round(timeSinceLastSuccessMs / 60000)} min ago — reconciling`,
    );

    // ------------------------------------------------------------------
    // 5. Determine the "since" timestamp for the Square Orders API query
    //    If no prior success, go back 24 hours as a reasonable lookback window
    // ------------------------------------------------------------------
    const sinceDate = lastSyncTimestamp
      ? new Date(lastSyncTimestamp.getTime())
      : new Date(nowMs - 24 * 60 * 60 * 1000);

    const sinceRfc3339 = sinceDate.toISOString();

    // ------------------------------------------------------------------
    // 6. Query Square Orders API
    // ------------------------------------------------------------------
    let squareOrders: SquareOrder[] = [];
    try {
      squareOrders = await fetchSquareOrdersSince(squareAccessToken, null, sinceRfc3339);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`square-reconcile: Square API error for business ${businessId}: ${errMsg}`);
      reconcileResults.push({
        business_id: businessId,
        outcome: "error",
        error: `Square API error: ${errMsg}`,
      });
      continue;
    }

    if (squareOrders.length === 0) {
      reconcileResults.push({
        business_id: businessId,
        outcome: "reconciled",
        orders_synthesized: 0,
        movements_created: 0,
      });
      continue;
    }

    // ------------------------------------------------------------------
    // 7. Find orders not already in square_sync_events
    // ------------------------------------------------------------------
    const orderIds = squareOrders.map((o) => o.id);

    // Square order IDs are stored as square_event_id in square_sync_events
    const { data: existingEvents, error: existingError } = await adminClient
      .from("square_sync_events")
      .select("square_event_id")
      .eq("business_id", businessId)
      .in("square_event_id", orderIds);

    if (existingError) {
      console.error(
        `square-reconcile: failed to check existing events for business ${businessId}:`,
        existingError.message,
      );
      reconcileResults.push({
        business_id: businessId,
        outcome: "error",
        error: existingError.message,
      });
      continue;
    }

    const alreadyProcessedIds = new Set(
      (existingEvents ?? []).map((e: { square_event_id: string }) => e.square_event_id),
    );

    const missingOrders = squareOrders.filter((o) => !alreadyProcessedIds.has(o.id));

    let totalMovements = 0;
    let ordersSynthesized = 0;

    // ------------------------------------------------------------------
    // 8. Synthesize and process each missing order
    // ------------------------------------------------------------------
    for (const order of missingOrders) {
      // Insert square_sync_events row for this synthesized event
      const { data: syncEvent, error: syncInsertError } = await adminClient
        .from("square_sync_events")
        .insert({
          business_id: businessId,
          square_event_type: "payment.completed",
          square_event_id: order.id,
          payload: { data: { object: { order } } },
          status: "pending",
          retry_count: 0,
        })
        .select("event_id")
        .single<{ event_id: string }>();

      if (syncInsertError) {
        // Unique constraint violation — already inserted by concurrent run
        if (syncInsertError.code === "23505") {
          console.log(`square-reconcile: order ${order.id} already exists — skipping`);
          continue;
        }
        console.error(
          `square-reconcile: failed to insert sync event for order ${order.id}:`,
          syncInsertError.message,
        );
        continue;
      }

      const eventId = syncEvent.event_id;

      // Process the synthesized event
      const { success, movementCount, errorMessage } = await processSynthesizedOrder(
        order,
        businessId,
        locationId,
        eventId,
        adminClient,
      );

      if (success) {
        // Update sync event to success
        await adminClient
          .from("square_sync_events")
          .update({
            status: "success",
            processed_at: new Date().toISOString(),
          })
          .eq("event_id", eventId);

        totalMovements += movementCount;
        ordersSynthesized++;
      } else {
        // Mark as failed — will be picked up by square-webhook-retry
        await adminClient
          .from("square_sync_events")
          .update({
            status: "pending",
            retry_count: 1,
            error_message: errorMessage,
          })
          .eq("event_id", eventId);

        console.warn(
          `square-reconcile: failed to process reconciled order ${order.id}: ${errorMessage}`,
        );
      }
    }

    reconcileResults.push({
      business_id: businessId,
      outcome: "reconciled",
      orders_synthesized: ordersSynthesized,
      movements_created: totalMovements,
    });
  }

  const summary = {
    status: "ok",
    businesses_processed: reconcileResults.length,
    results: reconcileResults,
  };

  console.log("square-reconcile: run complete", JSON.stringify(summary));
  return jsonResponse(summary);
});
