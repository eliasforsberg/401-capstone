/**
 * square-webhook Edge Function
 *
 * Ingests Square webhook events, verifies HMAC-SHA256 signatures, enforces
 * idempotency, and translates Square sales/refund/void events into inventory
 * movements in the ledger.
 *
 * REQUIRED ENVIRONMENT VARIABLES (set in Supabase Dashboard → Edge Functions → Secrets):
 *   SUPABASE_URL                   — Project URL (auto-set in hosted env)
 *   SUPABASE_SERVICE_ROLE_KEY      — Service role key (auto-set in hosted env)
 *   SQUARE_WEBHOOK_SIGNATURE_KEY   — Square webhook signature key (from Square Developer Dashboard)
 *   SQUARE_BUSINESS_ID             — The UUID of the business that owns this Square account
 *
 * SIGNATURE VERIFICATION:
 *   Square signs each webhook with HMAC-SHA256 of the raw request body, using
 *   the webhook signature key. The base64-encoded digest is sent in the
 *   `x-square-hmacsha256-signature` header. We recompute and compare using
 *   a timing-safe comparison to prevent timing attacks.
 *
 * EVENT DISPATCH:
 *   payment.completed / order.fulfilled  → createSaleMovements()
 *   refund.created / payment.refunded    → createReturnMovements()
 *   order.cancelled / payment.voided     → createOffsetMovements()
 *   Other events                         → 200 (acknowledged, not processed)
 *
 * IDEMPOTENCY:
 *   Each Square event has a unique `event_id`. We check square_sync_events for
 *   an existing row with the same square_event_id before processing. Duplicates
 *   receive an immediate 200 with status=duplicate.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.10
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SquareLineItem {
  catalog_object_id?: string;
  catalog_version?: number;
  quantity: string; // Square sends quantity as a string
  item_type?: string;
  base_price_money?: { amount: number; currency: string };
}

interface SquareOrder {
  id: string;
  line_items?: SquareLineItem[];
  returns?: Array<{
    return_line_items?: Array<{
      source_line_item_uid?: string;
      catalog_object_id?: string;
      quantity: string;
    }>;
  }>;
}

interface SquarePayment {
  id: string;
  order_id?: string;
  amount_money?: { amount: number; currency: string };
}

interface SquareRefund {
  id: string;
  payment_id?: string;
  order_id?: string;
  amount_money?: { amount: number; currency: string };
}

interface SquareWebhookEvent {
  merchant_id: string;
  type: string;
  event_id: string;
  created_at: string;
  data?: {
    type: string;
    id: string;
    object?: {
      order?: SquareOrder;
      payment?: SquarePayment;
      refund?: SquareRefund;
    };
  };
}

interface MovementInsert {
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  movement_type: "sale" | "return" | "adjustment";
  source: "pos_square";
  reference_id?: string;
  edge_fn_id: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 signature verification
// ---------------------------------------------------------------------------

async function verifySquareSignature(
  rawBody: string,
  signatureHeader: string,
  signatureKey: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(signatureKey);
  const messageData = encoder.encode(rawBody);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  const computedBase64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

  // Timing-safe comparison: compare lengths first, then each char
  if (computedBase64.length !== signatureHeader.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < computedBase64.length; i++) {
    mismatch |= computedBase64.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Business/location resolution
// ---------------------------------------------------------------------------

async function resolveBusinessAndLocation(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ locationId: string } | null> {
  const { data, error } = await supabase
    .from("locations")
    .select("location_id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    console.error("square-webhook: failed to resolve location:", error?.message);
    return null;
  }
  return { locationId: data.location_id };
}

// ---------------------------------------------------------------------------
// SKU resolution by Square catalog item ID
// ---------------------------------------------------------------------------

async function lookupSkuByCatalogItemId(
  supabase: SupabaseClient,
  businessId: string,
  catalogObjectId: string,
): Promise<string | null> {
  // First try dedicated square_catalog_item_id column (preferred after catalog sync)
  const { data, error } = await supabase
    .from("products")
    .select("product_id")
    .eq("business_id", businessId)
    .eq("square_catalog_item_id", catalogObjectId)
    .eq("is_active", true)
    .maybeSingle();

  if (!error && data) {
    return data.product_id;
  }

  // Fallback: treat sku as the square catalog item ID (before catalog sync runs)
  const { data: skuData, error: skuError } = await supabase
    .from("products")
    .select("product_id")
    .eq("business_id", businessId)
    .eq("sku", catalogObjectId)
    .eq("is_active", true)
    .maybeSingle();

  if (skuError || !skuData) {
    return null;
  }
  return skuData.product_id;
}

// ---------------------------------------------------------------------------
// Update sync event status
// ---------------------------------------------------------------------------

async function updateSyncEventStatus(
  supabase: SupabaseClient,
  eventId: string,
  status: "success" | "failed" | "unmatched",
  errorMessage?: string,
): Promise<void> {
  await supabase
    .from("square_sync_events")
    .update({
      status,
      processed_at: new Date().toISOString(),
      ...(errorMessage ? { error_message: errorMessage } : {}),
    })
    .eq("square_event_id", eventId);
}

// ---------------------------------------------------------------------------
// Insert square_unmatched alert
// ---------------------------------------------------------------------------

async function insertUnmatchedAlert(
  supabase: SupabaseClient,
  businessId: string,
  locationId: string,
  catalogObjectId: string,
  squareEventId: string,
): Promise<void> {
  await supabase.from("alerts").insert({
    business_id: businessId,
    location_id: locationId,
    sku_id: null,
    alert_type: "square_unmatched",
    status: "active",
    message: `Square webhook item could not be matched to a product SKU. ` +
      `Square catalog_object_id: ${catalogObjectId}. ` +
      `Square event_id: ${squareEventId}. ` +
      `Please link this item via the catalog sync or manually assign the Square ID to a product.`,
  });
}

// ---------------------------------------------------------------------------
// Event handler: sale movements (payment.completed / order.fulfilled)
// ---------------------------------------------------------------------------

async function createSaleMovements(
  supabase: SupabaseClient,
  event: SquareWebhookEvent,
  businessId: string,
  locationId: string,
): Promise<{ status: "success" | "unmatched"; unmatchedIds: string[] }> {
  // Extract line items — they live on the order object
  const lineItems: SquareLineItem[] = event.data?.object?.order?.line_items ?? [];

  if (lineItems.length === 0) {
    // No line items — mark success (nothing to decrement)
    return { status: "success", unmatchedIds: [] };
  }

  const unmatchedIds: string[] = [];
  const movements: MovementInsert[] = [];

  for (const item of lineItems) {
    const catalogId = item.catalog_object_id;
    if (!catalogId) continue;

    const skuId = await lookupSkuByCatalogItemId(supabase, businessId, catalogId);

    if (!skuId) {
      unmatchedIds.push(catalogId);
      continue;
    }

    const qty = parseFloat(item.quantity ?? "1");
    if (isNaN(qty) || qty <= 0) continue;

    movements.push({
      business_id: businessId,
      location_id: locationId,
      sku_id: skuId,
      quantity_delta: -qty,
      movement_type: "sale",
      source: "pos_square",
      reference_id: undefined, // no UUID reference — square event IDs are text strings
      edge_fn_id: "square-webhook",
      notes: `Square event: ${event.event_id} (${event.type})`,
    });
  }

  if (movements.length > 0) {
    const { error } = await supabase.from("inventory_movements").insert(movements);
    if (error) {
      throw new Error(`Failed to insert sale movements: ${error.message}`);
    }
  }

  return {
    status: unmatchedIds.length > 0 && movements.length === 0 ? "unmatched" : "success",
    unmatchedIds,
  };
}

// ---------------------------------------------------------------------------
// Event handler: return movements (refund.created / payment.refunded)
// ---------------------------------------------------------------------------

async function createReturnMovements(
  supabase: SupabaseClient,
  event: SquareWebhookEvent,
  businessId: string,
  locationId: string,
): Promise<{ status: "success" | "unmatched"; unmatchedIds: string[] }> {
  // Refund events may contain a full order with returns[], or just a refund object.
  // We look for return_line_items on the order's returns array first.
  const returnLineItems =
    event.data?.object?.order?.returns?.flatMap((r) => r.return_line_items ?? []) ?? [];

  if (returnLineItems.length === 0) {
    // No line-item detail — acknowledge without movement (partial refunds w/o item data)
    return { status: "success", unmatchedIds: [] };
  }

  const unmatchedIds: string[] = [];
  const movements: MovementInsert[] = [];

  for (const item of returnLineItems) {
    const catalogId = item.catalog_object_id;
    if (!catalogId) continue;

    const skuId = await lookupSkuByCatalogItemId(supabase, businessId, catalogId);

    if (!skuId) {
      unmatchedIds.push(catalogId);
      continue;
    }

    const qty = parseFloat(item.quantity ?? "1");
    if (isNaN(qty) || qty <= 0) continue;

    movements.push({
      business_id: businessId,
      location_id: locationId,
      sku_id: skuId,
      quantity_delta: qty, // positive — returning stock
      movement_type: "return",
      source: "pos_square",
      edge_fn_id: "square-webhook",
      notes: `Square refund event: ${event.event_id} (${event.type})`,
    });
  }

  if (movements.length > 0) {
    const { error } = await supabase.from("inventory_movements").insert(movements);
    if (error) {
      throw new Error(`Failed to insert return movements: ${error.message}`);
    }
  }

  return {
    status: unmatchedIds.length > 0 && movements.length === 0 ? "unmatched" : "success",
    unmatchedIds,
  };
}

// ---------------------------------------------------------------------------
// Event handler: offsetting movements (order.cancelled / payment.voided)
// ---------------------------------------------------------------------------

async function createOffsetMovements(
  supabase: SupabaseClient,
  event: SquareWebhookEvent,
  businessId: string,
  locationId: string,
): Promise<{ status: "success" | "unmatched"; unmatchedIds: string[] }> {
  // For a cancelled/voided order, we need to reverse any sale movements that
  // were already applied. We look up prior sale movements for this event's
  // order ID via the notes field or by querying existing movements.
  //
  // Strategy: treat the cancelled order the same as a refund — positive delta
  // for each line item using the order's line_items array.
  const lineItems: SquareLineItem[] = event.data?.object?.order?.line_items ?? [];

  if (lineItems.length === 0) {
    return { status: "success", unmatchedIds: [] };
  }

  const unmatchedIds: string[] = [];
  const movements: MovementInsert[] = [];

  for (const item of lineItems) {
    const catalogId = item.catalog_object_id;
    if (!catalogId) continue;

    const skuId = await lookupSkuByCatalogItemId(supabase, businessId, catalogId);

    if (!skuId) {
      unmatchedIds.push(catalogId);
      continue;
    }

    const qty = parseFloat(item.quantity ?? "1");
    if (isNaN(qty) || qty <= 0) continue;

    // Offsetting movement: positive delta to reverse the prior sale decrement
    movements.push({
      business_id: businessId,
      location_id: locationId,
      sku_id: skuId,
      quantity_delta: qty, // positive — reversing prior sale
      movement_type: "adjustment",
      source: "pos_square",
      edge_fn_id: "square-webhook",
      notes: `Square void/cancel offset: ${event.event_id} (${event.type})`,
    });
  }

  if (movements.length > 0) {
    const { error } = await supabase.from("inventory_movements").insert(movements);
    if (error) {
      throw new Error(`Failed to insert offset movements: ${error.message}`);
    }
  }

  return {
    status: unmatchedIds.length > 0 && movements.length === 0 ? "unmatched" : "success",
    unmatchedIds,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── 1. Read raw body (needed for HMAC verification before parsing JSON) ──
  const rawBody = await req.text();

  // ── 2. Verify HMAC-SHA256 signature ──
  const signatureHeader = req.headers.get("x-square-hmacsha256-signature") ?? "";
  const signatureKey = Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY") ?? "";

  if (!signatureKey) {
    console.error("square-webhook: SQUARE_WEBHOOK_SIGNATURE_KEY not configured");
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!signatureHeader) {
    console.warn("square-webhook: missing x-square-hmacsha256-signature header");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const signatureValid = await verifySquareSignature(rawBody, signatureHeader, signatureKey);
  if (!signatureValid) {
    console.warn("square-webhook: invalid HMAC signature");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── 3. Parse JSON body ──
  let event: SquareWebhookEvent;
  try {
    event = JSON.parse(rawBody) as SquareWebhookEvent;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const squareEventId = event.event_id;
  const eventType = event.type;

  if (!squareEventId || !eventType) {
    return new Response(JSON.stringify({ error: "Missing event_id or type" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── 4. Build service-role Supabase client ──
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("square-webhook: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 5. Resolve business ID ──
  const businessId = Deno.env.get("SQUARE_BUSINESS_ID") ?? "";
  if (!businessId) {
    console.error("square-webhook: SQUARE_BUSINESS_ID not configured");
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── 6. Idempotency check — return 200 immediately for duplicates ──
  const { data: existingEvent, error: lookupError } = await supabase
    .from("square_sync_events")
    .select("event_id, status")
    .eq("square_event_id", squareEventId)
    .maybeSingle();

  if (lookupError) {
    console.error("square-webhook: error checking idempotency:", lookupError.message);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (existingEvent) {
    // Duplicate — acknowledge immediately without reprocessing
    console.log(`square-webhook: duplicate event ${squareEventId}, acknowledging`);
    // Update status to duplicate if it isn't already (may arrive if a prior
    // run failed mid-way and left status=pending)
    if (existingEvent.status !== "duplicate") {
      await supabase
        .from("square_sync_events")
        .update({ status: "duplicate", processed_at: new Date().toISOString() })
        .eq("square_event_id", squareEventId);
    }
    return new Response(JSON.stringify({ status: "duplicate" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── 7. Insert square_sync_events row with status = 'pending' ──
  const { error: insertError } = await supabase.from("square_sync_events").insert({
    business_id: businessId,
    square_event_type: eventType,
    square_event_id: squareEventId,
    payload: JSON.parse(rawBody),
    status: "pending",
  });

  if (insertError) {
    // If this is a unique violation, another invocation beat us — treat as duplicate
    if (insertError.code === "23505") {
      console.log(`square-webhook: race-condition duplicate ${squareEventId}`);
      return new Response(JSON.stringify({ status: "duplicate" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("square-webhook: failed to insert sync event:", insertError.message);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── 8. Resolve the first active location for this business (MVP = single store) ──
  const locationResult = await resolveBusinessAndLocation(supabase, businessId);
  if (!locationResult) {
    await updateSyncEventStatus(supabase, squareEventId, "failed", "No active location found");
    return new Response(JSON.stringify({ error: "No active location configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { locationId } = locationResult;

  // ── 9. Dispatch to the appropriate event handler ──
  const SALE_EVENTS = new Set(["payment.completed", "order.fulfilled"]);
  const RETURN_EVENTS = new Set(["refund.created", "payment.refunded"]);
  const VOID_EVENTS = new Set(["order.cancelled", "payment.voided"]);

  try {
    let result: { status: "success" | "unmatched"; unmatchedIds: string[] };

    if (SALE_EVENTS.has(eventType)) {
      result = await createSaleMovements(supabase, event, businessId, locationId);
    } else if (RETURN_EVENTS.has(eventType)) {
      result = await createReturnMovements(supabase, event, businessId, locationId);
    } else if (VOID_EVENTS.has(eventType)) {
      result = await createOffsetMovements(supabase, event, businessId, locationId);
    } else {
      // Unrecognised event type — acknowledge without processing
      await updateSyncEventStatus(supabase, squareEventId, "success");
      return new Response(JSON.stringify({ status: "acknowledged", eventType }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle unmatched SKUs — insert alerts and update event status
    if (result.unmatchedIds.length > 0) {
      for (const catalogId of result.unmatchedIds) {
        await insertUnmatchedAlert(supabase, businessId, locationId, catalogId, squareEventId);
      }
      // If ALL items were unmatched set status=unmatched; otherwise success (some processed)
      await updateSyncEventStatus(
        supabase,
        squareEventId,
        result.status,
        result.unmatchedIds.length > 0
          ? `Unmatched catalog IDs: ${result.unmatchedIds.join(", ")}`
          : undefined,
      );
    } else {
      await updateSyncEventStatus(supabase, squareEventId, "success");
    }

    return new Response(
      JSON.stringify({ status: result.status, unmatchedCount: result.unmatchedIds.length }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`square-webhook: error processing event ${squareEventId}:`, message);

    // Read the current retry_count, increment it, and decide whether to dead-letter.
    // Status stays 'pending' so the retry scheduler can re-dispatch it; after 3
    // retries (retry_count reaches 3 — meaning 4 total attempts) set to 'failed'.
    const { data: currentRow } = await supabase
      .from("square_sync_events")
      .select("retry_count")
      .eq("square_event_id", squareEventId)
      .maybeSingle();

    const newRetryCount = (currentRow?.retry_count ?? 0) + 1;
    const newStatus = newRetryCount >= 3 ? "failed" : "pending";

    await supabase
      .from("square_sync_events")
      .update({
        retry_count: newRetryCount,
        status: newStatus,
        error_message: message,
        ...(newStatus === "failed" ? { processed_at: new Date().toISOString() } : {}),
      })
      .eq("square_event_id", squareEventId);

    return new Response(JSON.stringify({ error: "Processing error", details: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
