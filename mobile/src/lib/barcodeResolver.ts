/**
 * Barcode resolution — cache-first, network fallback.
 *
 * Resolution order:
 *   1. Synchronous MMKV cache lookup via `getCachedProductByBarcode()`.
 *   2. On cache miss: query Supabase `product_barcodes` → `products` →
 *      `inventory_balances`.
 *   3. If found on network: populate the cache entry and return the result.
 *   4. If not found anywhere: return `null`.
 *
 * Requirements: 7.1, 7.2, 7.4, 13.3
 */

import { supabase } from '@/lib/supabase';
import {
  getCachedProductByBarcode,
  getCachedProductById,
  catalogStorage,
} from '@/lib/catalogCache';
import type { CachedProduct } from '@/types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const productKey = (productId: string) => `product:${productId}`;
const barcodeKey = (barcode: string) => `barcode:${barcode}`;

/**
 * Persist a freshly-fetched product into the MMKV cache so subsequent scans
 * of the same or sibling barcode are resolved locally.
 */
function hydrateCacheEntry(product: CachedProduct): void {
  catalogStorage.set(productKey(product.productId), JSON.stringify(product));
  for (const barcode of product.barcodes) {
    catalogStorage.set(barcodeKey(barcode), product.productId);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a barcode string to a `CachedProduct` for the given business.
 *
 * @param barcode    - The raw barcode value scanned from the camera.
 * @param businessId - The authenticated user's business ID (from JWT / auth store).
 * @returns The matched `CachedProduct`, or `null` if no product is found.
 */
export async function resolveBarcode(
  barcode: string,
  businessId: string,
): Promise<CachedProduct | null> {
  // -------------------------------------------------------------------------
  // 1. Cache hit — synchronous, zero network cost.
  // -------------------------------------------------------------------------
  const cached = getCachedProductByBarcode(barcode);
  if (cached) return cached;

  // -------------------------------------------------------------------------
  // 2. Cache miss — query Supabase.
  //    Join: product_barcodes → products → inventory_balances
  // -------------------------------------------------------------------------
  const { data, error } = await supabase
    .from('product_barcodes')
    .select(
      `
      barcode_value,
      products (
        product_id,
        sku,
        name,
        is_active,
        product_barcodes ( barcode_value ),
        inventory_balances ( quantity, updated_at )
      )
    `,
    )
    .eq('business_id', businessId)
    .eq('barcode_value', barcode)
    .maybeSingle();

  if (error) {
    console.error('[barcodeResolver] Network query failed:', error.message);
    // Surface the error so callers can show an appropriate UI state.
    throw error;
  }

  if (!data || !data.products) return null;

  const product = data.products as {
    product_id: string;
    sku: string;
    name: string;
    is_active: boolean;
    product_barcodes: Array<{ barcode_value: string }>;
    inventory_balances: Array<{ quantity: number; updated_at: string }>;
  };

  // Only surface active products.
  if (!product.is_active) return null;

  // Collect all barcodes associated with this product.
  const barcodes: string[] = Array.isArray(product.product_barcodes)
    ? product.product_barcodes.map((b) => b.barcode_value)
    : [barcode];

  // Sum balances across locations.
  const balanceRows = Array.isArray(product.inventory_balances)
    ? product.inventory_balances
    : [];

  const totalBalance = balanceRows.reduce((sum, b) => sum + (b.quantity ?? 0), 0);
  const latestSyncedAt =
    balanceRows.length > 0
      ? balanceRows.reduce((latest, b) =>
          b.updated_at > latest.updated_at ? b : latest,
        ).updated_at
      : new Date().toISOString();

  const resolved: CachedProduct = {
    productId: product.product_id,
    sku: product.sku,
    name: product.name,
    barcodes,
    balance: totalBalance,
    balanceSyncedAt: latestSyncedAt,
  };

  // -------------------------------------------------------------------------
  // 3. Populate cache so next scan is free.
  // -------------------------------------------------------------------------
  hydrateCacheEntry(resolved);

  return resolved;
}

/**
 * Convenience helper: look up a product by its product ID, cache-first.
 * Useful when the caller already knows the product ID (e.g., after scanning
 * and navigating to the detail screen).
 */
export function resolveProductById(productId: string): CachedProduct | null {
  return getCachedProductById(productId);
}
