/**
 * square-webhook-retry Edge Function
 *
 * Scheduled function (every 5 minutes) that re-processes Square webhook events
 * which failed transiently. Implements exponential backoff gating and dead-letter
 * handling (status='failed') after 3 attempts.
 *
 * SCHEDULE
 *   Run every 5 minutes via Supabase cron / pg_cron / external scheduler.
 *   The function itself is invoked via HTTP POST (Deno.serve) by the scheduler.
 *
 * BACKOFF SCHEDULE (from design.md § Square Integration)
 *   attempt 1: immediate (retry_count = 0 → 1, processed on first failure)
 *   attempt 2: +30 seconds  (retry_count = 1)
 *   attempt 3: +2 minutes   (retry_count = 2)
 *   attempt 4: dead-letter  (retry_count >= 3 → status = 'failed')
 *
 * QUERY
 *   SELECT * FROM square_sync_events
 *   WHERE status = 'pending'
 *     AND retry_count > 0
 *   ORDER BY created_at ASC
 *   LIMIT 10
 *
 * REQUIRED ENVIRONMENT VARIABLES (auto-set in Supabase hosted env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SQUARE_ACCESS_TOKEN        — Bearer token for Square API calls
 *   SQUARE_ENVIRONMENT         — 'sandbox' or 'production'
 *   SQUARE_WEBHOOK_SIGNATURE_KEY — HMAC key (not needed for retry, but available)
 *
 * Requirements: 3.7
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SquareSyncEvent {
  event_id: string;
  business_id: string;
  square_event_type: string;
  square_event_id: string;
  payload: Record<string, unknown> | null;
  status: string;
  retry_count: number;
  processed_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at?: string;
}

interface MovementInsert {
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  movement_type: "sale" | "return" | "adjustment";
  reason_code?: string;
  source: "pos_square";
  reference_id: string;
  edge_fn_id: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Backoff thresholds in seconds
// ---------------------------------------------------------------------------

// retry_count=1 → must have waited at least 30s since last update
// retry_count=2 → must have waited at least 2 min since last update
const BACKOFF_SECONDS: Record<number, number> = {
  1: 30,
  2: 120,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Returns true if enough time has elapsed since the event was last updated
 * to warrant retrying based on its retry_count.
 */
function isBackoffElapsed(event: SquareSyncEvent): boolean {
  const retryCount = event.retry_count;

  // retry_count=1 → wait 30s, retry_count=2 → wait 2 min
  const requiredSeconds = BACKOFF_SECONDS[retryCount];

  // If no backoff threshold defined for this count, allow retry immediately
  if (requiredSeconds === undefined) {
    return true;
  }

  // Use created_at as fallback if updated_at is not available
  const lastUpdated = new Date(event.updated_at ?? event.created_at);
  const elapsed = (Date.now() - lastUpdated.getTime()) / 1000;
  return elapsed >= requiredSeconds;
}

/**
 * Core event handler — processes a single square_sync_events row.
 * Returns { success: boolean, errorMessage?: string }
 */
async function processSquareEvent(
  event: SquareSyncEvent,
  adminClient: ReturnType<typeof createClient>,
): Promise<{ success: boolean; errorMessage?: string }> {
  const { payload, square_event_type, event_id, business_id } = event;

  if (!payload) {
    return { success: false, errorMessage: "Event payload is null — cannot reprocess" };
  }

  try {
    // Fetch the default location for this business
    const { data: location, error: locationError } = await adminClient
      .from("locations")
      .select("location_id")
      .eq("business_id", business_id)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle<{ location_id: string }>();

    if (locationError || !location) {
      return {
        success: false,
        errorMessage: `No active location found for business ${business_id}: ${locationError?.message ?? "null result"}`,
      };
    }

    const locationId = location.location_id;
    const edgeFnId = "square-webhook-retry";

    // ------------------------------------------------------------------
    // Handle payment.completed / order.fulfilled → sale movements
    // ------------------------------------------------------------------
    if (
      square_event_type === "payment.completed" ||
      square_event_type === "order.fulfilled"
    ) {
      // Extract line items from payload
      // Square payment.completed payload structure:
      //   data.object.payment.order_id or data.object.order.line_items
      const data = payload.data as Record<string, unknown> | undefined;
      const objectField = data?.object as Record<string, unknown> | undefined;

      // Try to get line items from order
      let lineItems: Array<Record<string, unknown>> = [];

      const order = objectField?.order as Record<string, unknown> | undefined;
      if (order?.line_items) {
        lineItems = order.line_items as Array<Record<string, unknown>>;
      }

      // Also try payment.order_id path
      const payment = objectField?.payment as Record<string, unknown> | undefined;

      if (lineItems.length === 0) {
        // No line items to process — mark success (nothing to decrement)
        return { success: true };
      }

      const unmatchedItemIds: string[] = [];
      const movementsToInsert: MovementInsert[] = [];

      for (const item of lineItems) {
        const catalogObjectId = item.catalog_object_id as string | undefined;
        const quantity = parseFloat(
          (item.quantity as string | undefined) ?? "1",
        );

        if (!catalogObjectId) {
          // No catalog ID — skip
          continue;
        }

        // Look up product by square_catalog_item_id
        const { data: product, error: productError } = await adminClient
          .from("products")
          .select("product_id")
          .eq("business_id", business_id)
          .eq("square_catalog_item_id", catalogObjectId)
          .eq("is_active", true)
          .maybeSingle<{ product_id: string }>();

        if (productError || !product) {
          unmatchedItemIds.push(catalogObjectId);
          continue;
        }

        movementsToInsert.push({
          business_id,
          location_id: locationId,
          sku_id: product.product_id,
          quantity_delta: -quantity,
          movement_type: "sale",
          source: "pos_square",
          reference_id: event_id,
          edge_fn_id: edgeFnId,
        });
      }

      // Insert sale movements
      if (movementsToInsert.length > 0) {
        const { error: insertError } = await adminClient
          .from("inventory_movements")
          .insert(movementsToInsert);

        if (insertError) {
          return { success: false, errorMessage: `Failed to insert sale movements: ${insertError.message}` };
        }
      }

      // Handle unmatched items — insert alerts
      if (unmatchedItemIds.length > 0) {
        for (const unmatchedId of unmatchedItemIds) {
          await adminClient.from("alerts").insert({
            business_id,
            location_id: locationId,
            alert_type: "square_unmatched",
            message: `Square catalog item ${unmatchedId} could not be matched to a product SKU. Event ID: ${event_id}`,
          });
        }

        // Mark event as unmatched if ALL items were unmatched
        if (unmatchedItemIds.length === lineItems.length) {
          await adminClient
            .from("square_sync_events")
            .update({ status: "unmatched", processed_at: new Date().toISOString() })
            .eq("event_id", event_id);
          // Return success=true so we don't keep retrying an unmatched event
          return { success: true };
        }
      }

      return { success: true };
    }

    // ------------------------------------------------------------------
    // Handle refund.created / payment.refunded → return movements
    // ------------------------------------------------------------------
    if (
      square_event_type === "refund.created" ||
      square_event_type === "payment.refunded"
    ) {
      const data = payload.data as Record<string, unknown> | undefined;
      const objectField = data?.object as Record<string, unknown> | undefined;
      const refund = objectField?.refund as Record<string, unknown> | undefined;

      // Refunds reference the original payment/order
      const originalPaymentId = refund?.payment_id as string | undefined;
      const lineItems = (refund?.line_items as Array<Record<string, unknown>> | undefined) ?? [];

      // Find the original square_sync_events entry to reference
      let originalEventId: string | null = null;
      if (originalPaymentId) {
        const { data: originalEvent } = await adminClient
          .from("square_sync_events")
          .select("event_id")
          .eq("square_event_id", originalPaymentId)
          .maybeSingle<{ event_id: string }>();
        originalEventId = originalEvent?.event_id ?? null;
      }

      const movementsToInsert: MovementInsert[] = [];

      for (const item of lineItems) {
        const catalogObjectId = item.catalog_object_id as string | undefined;
        const quantity = parseFloat(
          (item.quantity as string | undefined) ?? "1",
        );

        if (!catalogObjectId) continue;

        const { data: product } = await adminClient
          .from("products")
          .select("product_id")
          .eq("business_id", business_id)
          .eq("square_catalog_item_id", catalogObjectId)
          .eq("is_active", true)
          .maybeSingle<{ product_id: string }>();

        if (!product) continue;

        movementsToInsert.push({
          business_id,
          location_id: locationId,
          sku_id: product.product_id,
          quantity_delta: quantity, // positive — returning stock
          movement_type: "return",
          source: "pos_square",
          reference_id: originalEventId ?? event_id,
          edge_fn_id: edgeFnId,
          notes: `Refund/return for Square event ${event_id}`,
        });
      }

      if (movementsToInsert.length > 0) {
        const { error: insertError } = await adminClient
          .from("inventory_movements")
          .insert(movementsToInsert);

        if (insertError) {
          return { success: false, errorMessage: `Failed to insert return movements: ${insertError.message}` };
        }
      }

      return { success: true };
    }

    // ------------------------------------------------------------------
    // Handle order.cancelled / payment.voided → offsetting movements
    // ------------------------------------------------------------------
    if (
      square_event_type === "order.cancelled" ||
      square_event_type === "payment.voided"
    ) {
      // Find the original sale movements for this event and create offsets
      const { data: originalMovements, error: movementsError } = await adminClient
        .from("inventory_movements")
        .select("movement_id, sku_id, location_id, quantity_delta")
        .eq("reference_id", event_id)
        .eq("movement_type", "sale")
        .eq("source", "pos_square");

      if (movementsError) {
        return { success: false, errorMessage: `Failed to query original movements: ${movementsError.message}` };
      }

      // No original movements — nothing to void
      if (!originalMovements || originalMovements.length === 0) {
        return { success: true };
      }

      const offsetMovements: MovementInsert[] = originalMovements.map(
        (m: { movement_id: string; sku_id: string; location_id: string; quantity_delta: number }) => ({
          business_id,
          location_id: m.location_id,
          sku_id: m.sku_id,
          quantity_delta: -m.quantity_delta, // exact inverse
          movement_type: "adjustment" as const,
          reason_code: "counting_correction",
          source: "pos_square" as const,
          reference_id: m.movement_id,
          edge_fn_id: edgeFnId,
          notes: `Void/cancellation offset for Square event ${event_id}`,
        }),
      );

      const { error: insertError } = await adminClient
        .from("inventory_movements")
        .insert(offsetMovements);

      if (insertError) {
        return { success: false, errorMessage: `Failed to insert offset movements: ${insertError.message}` };
      }

      return { success: true };
    }

    // Unknown event type — mark as success to stop retrying
    console.warn(`square-webhook-retry: unknown event type '${square_event_type}' for event ${event_id}`);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, errorMessage: `Unexpected error: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Main scheduled handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // Allow POST (triggered by scheduler) or GET (manual trigger)
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("square-webhook-retry: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ------------------------------------------------------------------
  // 1. Query events that are pending and have already been attempted
  //    (retry_count > 0 means first attempt already failed)
  // ------------------------------------------------------------------
  const { data: events, error: queryError } = await adminClient
    .from("square_sync_events")
    .select("*")
    .eq("status", "pending")
    .gt("retry_count", 0)
    .order("created_at", { ascending: true })
    .limit(10);

  if (queryError) {
    console.error("square-webhook-retry: failed to query events", queryError.message);
    return jsonResponse({ error: "Failed to query events" }, 500);
  }

  if (!events || events.length === 0) {
    return jsonResponse({ status: "ok", processed: 0, message: "No pending retry events" });
  }

  // ------------------------------------------------------------------
  // 2. Process each event with backoff gate and dead-letter logic
  // ------------------------------------------------------------------
  const results: Array<{
    event_id: string;
    outcome: "retried_success" | "retried_failed" | "dead_lettered" | "backoff_skip";
  }> = [];

  for (const rawEvent of events) {
    const event = rawEvent as SquareSyncEvent;
    const { event_id, retry_count } = event;

    // ------------------------------------------------------------------
    // 2a. Dead-letter: 3 or more prior failures → mark failed
    // ------------------------------------------------------------------
    if (retry_count >= 3) {
      const { error: deadLetterError } = await adminClient
        .from("square_sync_events")
        .update({
          status: "failed",
          error_message: `Exceeded maximum retry attempts (${retry_count}). Moved to dead-letter queue.`,
          processed_at: new Date().toISOString(),
        })
        .eq("event_id", event_id);

      if (deadLetterError) {
        console.error(
          `square-webhook-retry: failed to dead-letter event ${event_id}:`,
          deadLetterError.message,
        );
      } else {
        console.log(`square-webhook-retry: dead-lettered event ${event_id} after ${retry_count} attempts`);
      }

      results.push({ event_id, outcome: "dead_lettered" });
      continue;
    }

    // ------------------------------------------------------------------
    // 2b. Backoff gate: check if enough time has elapsed since last attempt
    // ------------------------------------------------------------------
    if (!isBackoffElapsed(event)) {
      results.push({ event_id, outcome: "backoff_skip" });
      continue;
    }

    // ------------------------------------------------------------------
    // 2c. Attempt reprocessing
    // ------------------------------------------------------------------
    const { success, errorMessage } = await processSquareEvent(event, adminClient);

    if (success) {
      const { error: updateError } = await adminClient
        .from("square_sync_events")
        .update({
          status: "success",
          processed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("event_id", event_id);

      if (updateError) {
        console.error(
          `square-webhook-retry: failed to mark event ${event_id} as success:`,
          updateError.message,
        );
      }

      results.push({ event_id, outcome: "retried_success" });
    } else {
      const newRetryCount = retry_count + 1;

      const { error: updateError } = await adminClient
        .from("square_sync_events")
        .update({
          retry_count: newRetryCount,
          error_message: errorMessage ?? "Unknown error during retry",
          // updated_at is used for backoff timing — update it on each attempt
        })
        .eq("event_id", event_id);

      if (updateError) {
        console.error(
          `square-webhook-retry: failed to increment retry_count for ${event_id}:`,
          updateError.message,
        );
      }

      console.warn(
        `square-webhook-retry: event ${event_id} failed on attempt ${newRetryCount}: ${errorMessage}`,
      );

      results.push({ event_id, outcome: "retried_failed" });
    }
  }

  const summary = {
    status: "ok",
    processed: results.length,
    retried_success: results.filter((r) => r.outcome === "retried_success").length,
    retried_failed: results.filter((r) => r.outcome === "retried_failed").length,
    dead_lettered: results.filter((r) => r.outcome === "dead_lettered").length,
    backoff_skip: results.filter((r) => r.outcome === "backoff_skip").length,
    results,
  };

  console.log("square-webhook-retry: run complete", JSON.stringify(summary));
  return jsonResponse(summary);
});
