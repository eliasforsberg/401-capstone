/**
 * MMKV-backed product catalog cache.
 *
 * Storage layout (per product):
 *   `product:{productId}`     → JSON-serialised CachedProduct
 *   `barcode:{barcodeValue}`  → productId string (lookup index)
 *
 * The cache is loaded at app startup and on reconnect via
 * `loadCatalogFromServer()`.  Barcode scans resolve synchronously against the
 * cache and fall back to a network query via `barcodeResolver.ts`.
 *
 * On web, MMKV is not available. We use an in-memory Map as a non-persistent
 * fallback so the web build doesn't crash.
 */

import { Platform } from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CachedProduct } from '@/types';

// ---------------------------------------------------------------------------
// Storage abstraction: MMKV on native, in-memory on web
// ---------------------------------------------------------------------------

interface CatalogStorage {
  getString: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  delete: (key: string) => void;
  clearAll: () => void;
}

function createCatalogStorage(): CatalogStorage {
  if (Platform.OS !== 'web') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
      return new MMKV({ id: 'product-catalog' });
    } catch (e) {
      // MMKV JSI unavailable — fall back to in-memory
      console.warn('[catalogCache] MMKV unavailable, using in-memory storage:', e);
    }
  }
  // In-memory fallback for web or when MMKV is unavailable
  const store = new Map<string, string>();
  return {
    getString: (key) => store.get(key),
    set: (key, value) => { store.set(key, value); },
    delete: (key) => { store.delete(key); },
    clearAll: () => { store.clear(); },
  };
}

export const catalogStorage = createCatalogStorage();

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const productKey = (productId: string) => `product:${productId}`;
const barcodeKey = (barcode: string) => `barcode:${barcode}`;

// ---------------------------------------------------------------------------
// Read helpers (synchronous)
// ---------------------------------------------------------------------------

/**
 * Look up a cached product by barcode value.
 * Returns `null` on cache miss.
 */
export function getCachedProductByBarcode(barcode: string): CachedProduct | null {
  const productId = catalogStorage.getString(barcodeKey(barcode));
  if (!productId) return null;
  return getCachedProductById(productId);
}

/**
 * Look up a cached product by product ID.
 * Returns `null` on cache miss.
 */
export function getCachedProductById(productId: string): CachedProduct | null {
  const raw = catalogStorage.getString(productKey(productId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedProduct;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Write (or overwrite) a product entry and all its barcode lookup keys.
 */
function setCachedProduct(product: CachedProduct): void {
  catalogStorage.set(productKey(product.productId), JSON.stringify(product));
  for (const barcode of product.barcodes) {
    catalogStorage.set(barcodeKey(barcode), product.productId);
  }
}

/**
 * Update only the balance fields of an existing cached product.
 * No-ops if the product is not in the cache.
 */
export function updateCachedBalance(productId: string, newBalance: number): void {
  const existing = getCachedProductById(productId);
  if (!existing) return;
  const updated: CachedProduct = {
    ...existing,
    balance: newBalance,
    balanceSyncedAt: new Date().toISOString(),
  };
  catalogStorage.set(productKey(productId), JSON.stringify(updated));
}

/**
 * Wipe the entire product-catalog MMKV store.
 * Call this on sign-out to remove all business data from the device.
 */
export function clearCatalogCache(): void {
  catalogStorage.clearAll();
}

// ---------------------------------------------------------------------------
// Server load
// ---------------------------------------------------------------------------

/**
 * Fetch all active products for a business — with their barcodes and current
 * balances — and write them into the MMKV cache.
 *
 * This function is called at app startup and on network reconnect.
 *
 * Query design:
 *   products (active, matching businessId)
 *     ↳ product_barcodes  (array of barcode values)
 *     ↳ inventory_balances (most recent balance quantity per product)
 */
export async function loadCatalogFromServer(
  businessId: string,
  supabaseClient: SupabaseClient,
): Promise<void> {
  // Fetch active products with their barcodes in a single query.
  const { data: products, error: productsError } = await supabaseClient
    .from('products')
    .select(
      `
      product_id,
      sku,
      name,
      product_barcodes ( barcode_value ),
      inventory_balances ( quantity, updated_at )
    `,
    )
    .eq('business_id', businessId)
    .eq('is_active', true);

  if (productsError) {
    console.error('[catalogCache] Failed to load catalog from server:', productsError.message);
    throw productsError;
  }

  if (!products) return;

  const now = new Date().toISOString();

  for (const row of products) {
    // Collect all barcode values for this product.
    const barcodes: string[] = Array.isArray(row.product_barcodes)
      ? (row.product_barcodes as Array<{ barcode_value: string }>).map((b) => b.barcode_value)
      : [];

    // Use the first balance row if present (there should be at most one per
    // business when location is implicit; take max if multiple locations exist).
    const balanceRows = Array.isArray(row.inventory_balances)
      ? (row.inventory_balances as Array<{ quantity: number; updated_at: string }>)
      : [];

    const totalBalance = balanceRows.reduce((sum, b) => sum + (b.quantity ?? 0), 0);
    const latestSyncedAt =
      balanceRows.length > 0
        ? balanceRows.reduce((latest, b) =>
            b.updated_at > latest.updated_at ? b : latest,
          ).updated_at
        : now;

    const cached: CachedProduct = {
      productId: row.product_id as string,
      sku: row.sku as string,
      name: row.name as string,
      barcodes,
      balance: totalBalance,
      balanceSyncedAt: latestSyncedAt,
    };

    setCachedProduct(cached);
  }
}
