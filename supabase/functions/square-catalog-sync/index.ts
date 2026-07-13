/**
 * square-catalog-sync Edge Function
 *
 * Maps Square catalog items to the local `products`, `product_variants`, and
 * `product_barcodes` tables. Designed to be run on initial Square connection
 * and on Square catalog.updated webhook events.
 *
 * FLOW
 *   1. Authenticate caller (owner role required — catalog sync is a privileged op)
 *   2. Call Square Catalog API: GET /v2/catalog/list?types=ITEM
 *   3. For each catalog ITEM:
 *      a. Upsert into `products` by square_catalog_item_id
 *      b. For each ITEM_VARIATION:
 *         - Upsert into `product_variants` by sku or square_catalog_item_id
 *      c. For each ITEM with a GTIN/barcode measurement unit:
 *         - Upsert into `product_barcodes`
 *   4. Return summary of upserted records
 *
 * SQUARE CATALOG STRUCTURE
 *   CatalogObject (type=ITEM)
 *     └── item_data
 *           ├── name
 *           ├── description
 *           ├── category_id
 *           └── variations: CatalogObject[] (type=ITEM_VARIATION)
 *                 └── item_variation_data
 *                       ├── name
 *                       ├── sku
 *                       ├── price_money
 *                       └── measurement_unit_id (→ barcode via custom_unit)
 *
 * NOTE ON BARCODE DATA
 *   Square does not store standard barcodes (UPC/EAN) natively in the catalog.
 *   Barcodes are stored in the "custom_attribute_values" of an item variation
 *   under a custom attribute definition, or embedded via the item_variation_data
 *   "upc" field (available in Square Retail). This function checks both paths.
 *
 * REQUEST
 *   POST /functions/v1/square-catalog-sync
 *   Authorization: Bearer <user JWT — must be owner role>
 *   Content-Type: application/json
 *   Body: { business_id?: string, location_id?: string }
 *         (optional override; defaults to the caller's business/default location)
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SQUARE_ACCESS_TOKEN
 *   SQUARE_ENVIRONMENT  — 'sandbox' | 'production'
 *
 * Requirements: 3.1 (SKU matching), Phase 2 catalog sync requirement
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SQUARE_API_BASE = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SquareMoney {
  amount: number;
  currency: string;
}

interface SquareItemVariationData {
  item_id?: string;
  name?: string;
  sku?: string;
  upc?: string;
  price_money?: SquareMoney;
  pricing_type?: string;
  service_duration?: number;
}

interface SquareItemData {
  name?: string;
  description?: string;
  category_id?: string;
  variations?: SquareCatalogObject[];
}

interface SquareCustomAttributeValue {
  name?: string;
  string_value?: string;
  type?: string;
}

interface SquareCatalogObject {
  type: "ITEM" | "ITEM_VARIATION" | "CATEGORY" | "TAX" | "DISCOUNT" | string;
  id: string;
  updated_at?: string;
  version?: number;
  is_deleted?: boolean;
  item_data?: SquareItemData;
  item_variation_data?: SquareItemVariationData;
  custom_attribute_values?: Record<string, SquareCustomAttributeValue>;
}

interface SquareCatalogListResponse {
  objects?: SquareCatalogObject[];
  cursor?: string;
  errors?: Array<{ category: string; code: string; detail: string }>;
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
 * Fetch all ITEM catalog objects from Square Catalog API.
 * Handles pagination via cursor.
 */
async function fetchSquareCatalogItems(
  accessToken: string,
): Promise<SquareCatalogObject[]> {
  const baseUrl = squareBaseUrl();
  const allObjects: SquareCatalogObject[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL(`${baseUrl}/v2/catalog/list`);
    url.searchParams.set("types", "ITEM");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2024-01-18",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Square Catalog API returned ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as SquareCatalogListResponse;

    if (data.errors && data.errors.length > 0) {
      throw new Error(
        `Square Catalog API errors: ${data.errors.map((e) => `${e.code}: ${e.detail}`).join("; ")}`,
      );
    }

    if (data.objects) {
      allObjects.push(...data.objects);
    }

    cursor = data.cursor;
  } while (cursor);

  return allObjects;
}

/**
 * Extract barcode/UPC string from a Square item variation.
 * Checks:
 *   1. item_variation_data.upc (Square Retail)
 *   2. custom_attribute_values for any attribute containing 'barcode', 'upc', 'gtin', 'ean'
 */
function extractBarcode(variation: SquareCatalogObject): string | null {
  // 1. Direct UPC field (Square Retail)
  if (variation.item_variation_data?.upc) {
    return variation.item_variation_data.upc;
  }

  // 2. Custom attribute values
  const attrs = variation.custom_attribute_values ?? {};
  for (const [key, attr] of Object.entries(attrs)) {
    const keyLower = key.toLowerCase();
    if (
      (keyLower.includes("barcode") ||
        keyLower.includes("upc") ||
        keyLower.includes("gtin") ||
        keyLower.includes("ean")) &&
      attr.string_value
    ) {
      return attr.string_value;
    }
  }

  return null;
}

/**
 * Infer barcode type from value format.
 */
function inferBarcodeType(barcode: string): string {
  const len = barcode.length;
  // Strip non-numeric for length check
  const numeric = barcode.replace(/\D/g, "");

  if (numeric.length === 12) return "UPC-A";
  if (numeric.length === 13) return "EAN-13";
  if (numeric.length === 8) return "EAN-8";
  if (numeric.length === 14) return "GTIN-14";
  if (/^[0-9A-Z\-. $/+%]+$/.test(barcode)) return "Code 39";
  return "Code 128";
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed — use POST" }, 405);
  }

  // ------------------------------------------------------------------
  // 1. Authenticate caller
  // ------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized: missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const squareAccessToken = Deno.env.get("SQUARE_ACCESS_TOKEN");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error("square-catalog-sync: missing required Supabase env vars");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  if (!squareAccessToken) {
    return jsonResponse({ error: "SQUARE_ACCESS_TOKEN is not configured" }, 503);
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
    return jsonResponse({ error: "Unauthorized: invalid or expired token" }, 401);
  }

  // Resolve caller's business and role
  const { data: userRole, error: roleError } = await adminClient
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", user.id)
    .maybeSingle<{ business_id: string; role: string }>();

  if (roleError || !userRole) {
    return jsonResponse({ error: "Unauthorized: user has no business role" }, 401);
  }

  const { business_id, role } = userRole;

  // Catalog sync requires owner role (configuring integrations = owner only per Req 9.2)
  if (role !== "owner") {
    return jsonResponse(
      { error: "Forbidden: only Owner role can run catalog sync" },
      403,
    );
  }

  // ------------------------------------------------------------------
  // 2. Parse optional body overrides
  // ------------------------------------------------------------------
  let bodyLocationId: string | undefined;
  try {
    const bodyText = await req.text();
    if (bodyText.trim()) {
      const bodyJson = JSON.parse(bodyText) as { location_id?: string };
      bodyLocationId = bodyJson.location_id;
    }
  } catch {
    // Non-fatal — use defaults
  }

  // Resolve default location for this business
  const locationQuery = adminClient
    .from("locations")
    .select("location_id")
    .eq("business_id", business_id)
    .eq("is_active", true)
    .limit(1);

  const { data: locationRow, error: locationError } = await (bodyLocationId
    ? locationQuery.eq("location_id", bodyLocationId)
    : locationQuery
  ).maybeSingle<{ location_id: string }>();

  if (locationError || !locationRow) {
    return jsonResponse({ error: "No active location found for this business" }, 400);
  }

  const locationId = locationRow.location_id;

  // ------------------------------------------------------------------
  // 3. Fetch Square catalog items
  // ------------------------------------------------------------------
  let catalogItems: SquareCatalogObject[];
  try {
    catalogItems = await fetchSquareCatalogItems(squareAccessToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("square-catalog-sync: failed to fetch catalog:", msg);
    return jsonResponse({ error: `Square Catalog API error: ${msg}` }, 502);
  }

  console.log(`square-catalog-sync: fetched ${catalogItems.length} catalog items`);

  // ------------------------------------------------------------------
  // 4. Process each catalog ITEM
  // ------------------------------------------------------------------
  const stats = {
    products_upserted: 0,
    products_skipped: 0,
    variants_upserted: 0,
    barcodes_upserted: 0,
    errors: 0,
  };

  for (const catalogItem of catalogItems) {
    if (catalogItem.type !== "ITEM" || catalogItem.is_deleted) {
      continue;
    }

    const itemData = catalogItem.item_data;
    if (!itemData) continue;

    const itemName = itemData.name ?? `Square Item ${catalogItem.id}`;
    const squareCatalogItemId = catalogItem.id;

    // ------------------------------------------------------------------
    // 4a. Upsert into `products` by square_catalog_item_id
    // ------------------------------------------------------------------
    // Check if a product already exists for this Square item ID
    const { data: existingProduct, error: existingProductError } = await adminClient
      .from("products")
      .select("product_id, sku, name")
      .eq("business_id", business_id)
      .eq("square_catalog_item_id", squareCatalogItemId)
      .maybeSingle<{ product_id: string; sku: string; name: string }>();

    if (existingProductError) {
      console.error(
        `square-catalog-sync: error looking up product for item ${squareCatalogItemId}:`,
        existingProductError.message,
      );
      stats.errors++;
      continue;
    }

    let productId: string;

    if (existingProduct) {
      // Product already linked to this Square item — update name/details if changed
      if (existingProduct.name !== itemName) {
        const { error: updateError } = await adminClient
          .from("products")
          .update({
            name: itemName,
            updated_at: new Date().toISOString(),
          })
          .eq("product_id", existingProduct.product_id);

        if (updateError) {
          console.warn(
            `square-catalog-sync: failed to update product ${existingProduct.product_id}:`,
            updateError.message,
          );
        }
      }

      productId = existingProduct.product_id;
      stats.products_skipped++;
    } else {
      // Create new product record
      // Generate a SKU from the Square item ID (truncated, prefixed) if no variation SKU available
      const firstVariation = itemData.variations?.[0];
      const variationSku = firstVariation?.item_variation_data?.sku;

      // Use variation SKU if present, else generate from Square item ID
      const sku = variationSku ?? `SQ-${squareCatalogItemId.slice(-12)}`;

      // Check if SKU already exists (another product might use the same SKU string)
      const { data: skuConflict } = await adminClient
        .from("products")
        .select("product_id")
        .eq("business_id", business_id)
        .eq("sku", sku)
        .maybeSingle<{ product_id: string }>();

      if (skuConflict) {
        // Link the existing product to this Square item instead of creating duplicate
        const { error: linkError } = await adminClient
          .from("products")
          .update({
            square_catalog_item_id: squareCatalogItemId,
            updated_at: new Date().toISOString(),
          })
          .eq("product_id", skuConflict.product_id);

        if (linkError) {
          console.warn(
            `square-catalog-sync: failed to link existing product for SKU ${sku}:`,
            linkError.message,
          );
          stats.errors++;
          continue;
        }

        productId = skuConflict.product_id;
        stats.products_upserted++;
      } else {
        // Insert new product
        const sellingPrice = firstVariation?.item_variation_data?.price_money?.amount
          ? firstVariation.item_variation_data.price_money.amount / 100 // Square stores cents
          : null;

        const { data: newProduct, error: insertError } = await adminClient
          .from("products")
          .insert({
            business_id,
            sku,
            name: itemName,
            description: itemData.description ?? null,
            square_catalog_item_id: squareCatalogItemId,
            selling_price: sellingPrice,
            is_active: true,
          })
          .select("product_id")
          .single<{ product_id: string }>();

        if (insertError || !newProduct) {
          console.error(
            `square-catalog-sync: failed to insert product for item ${squareCatalogItemId}:`,
            insertError?.message,
          );
          stats.errors++;
          continue;
        }

        productId = newProduct.product_id;
        stats.products_upserted++;
      }
    }

    // ------------------------------------------------------------------
    // 4b. Process item variations → product_variants
    // ------------------------------------------------------------------
    const variations = itemData.variations ?? [];

    for (const variation of variations) {
      if (variation.type !== "ITEM_VARIATION" || variation.is_deleted) {
        continue;
      }

      const varData = variation.item_variation_data;
      if (!varData) continue;

      const varName = varData.name ?? "Default";
      const varSku = varData.sku
        ? varData.sku
        : `SQ-VAR-${variation.id.slice(-12)}`;

      const varSellingPrice = varData.price_money?.amount
        ? varData.price_money.amount / 100
        : null;

      // Check for existing variant by SKU within this business
      const { data: existingVariant, error: existingVarError } = await adminClient
        .from("product_variants")
        .select("variant_id")
        .eq("business_id", business_id)
        .eq("sku", varSku)
        .maybeSingle<{ variant_id: string }>();

      if (existingVarError) {
        console.warn(
          `square-catalog-sync: error checking variant SKU ${varSku}:`,
          existingVarError.message,
        );
        continue;
      }

      if (!existingVariant) {
        const { error: varInsertError } = await adminClient
          .from("product_variants")
          .insert({
            product_id: productId,
            business_id,
            sku: varSku,
            name: varName,
            unit_multiplier: 1, // Square doesn't natively express pack multipliers
            selling_price: varSellingPrice,
            is_active: true,
          });

        if (varInsertError) {
          // SKU conflict on another product — skip gracefully
          if (varInsertError.code !== "23505") {
            console.warn(
              `square-catalog-sync: failed to insert variant ${varSku}:`,
              varInsertError.message,
            );
          }
        } else {
          stats.variants_upserted++;
        }
      }

      // ------------------------------------------------------------------
      // 4c. Extract barcode/UPC from variation → product_barcodes
      // ------------------------------------------------------------------
      const barcode = extractBarcode(variation);

      if (barcode && barcode.trim().length > 0) {
        const barcodeValue = barcode.trim();
        const barcodeType = inferBarcodeType(barcodeValue);

        // Upsert — if this barcode already exists for this business, update to
        // point at the correct product (in case catalog was reorganized)
        const { error: barcodeUpsertError } = await adminClient
          .from("product_barcodes")
          .upsert(
            {
              business_id,
              product_id: productId,
              barcode_value: barcodeValue,
              barcode_type: barcodeType,
              is_primary: true,
            },
            {
              onConflict: "business_id,barcode_value",
              ignoreDuplicates: false, // update product_id if catalog reassigned it
            },
          );

        if (barcodeUpsertError) {
          console.warn(
            `square-catalog-sync: failed to upsert barcode ${barcodeValue}:`,
            barcodeUpsertError.message,
          );
        } else {
          stats.barcodes_upserted++;
        }
      }
    }
  }

  const result = {
    status: "ok",
    business_id,
    location_id: locationId,
    catalog_items_fetched: catalogItems.filter((o) => o.type === "ITEM" && !o.is_deleted).length,
    ...stats,
  };

  console.log("square-catalog-sync: complete", JSON.stringify(result));
  return jsonResponse(result);
});
