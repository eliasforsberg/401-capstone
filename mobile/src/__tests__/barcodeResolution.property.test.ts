// Feature: ai-inventory-manager
// Property 12: Barcode Resolution Uniqueness
//
// Validates: Requirements 7.2, 7.5
//
// Pure-logic property tests — no Supabase, no network.
// Tests the barcode → product mapping rules: one barcode resolves to exactly
// one product, and duplicate barcode registrations are rejected.

import fc from 'fast-check';

// ---------------------------------------------------------------------------
// In-memory barcode registry (mirrors the DB UNIQUE constraint)
// ---------------------------------------------------------------------------

export interface BarcodeEntry {
  barcode: string;
  productId: string;
}

export interface BarcodeRegistry {
  /** barcode → productId */
  readonly map: ReadonlyMap<string, string>;
}

/** Result of attempting to register a barcode. */
export type RegisterResult =
  | { ok: true }
  | { ok: false; conflict: { barcode: string; existingProductId: string } };

/**
 * Attempt to register a (barcode, productId) pair.
 * Mirrors the UNIQUE (business_id, barcode_value) constraint on product_barcodes.
 */
export function registerBarcode(
  registry: Map<string, string>,
  entry: BarcodeEntry,
): RegisterResult {
  const existing = registry.get(entry.barcode);
  if (existing !== undefined && existing !== entry.productId) {
    return { ok: false, conflict: { barcode: entry.barcode, existingProductId: existing } };
  }
  registry.set(entry.barcode, entry.productId);
  return { ok: true };
}

/**
 * Resolve a barcode to a product ID.
 * Returns null if the barcode is not registered.
 */
export function resolveBarcode(
  registry: ReadonlyMap<string, string>,
  barcode: string,
): string | null {
  return registry.get(barcode) ?? null;
}

/**
 * Build a registry from a list of entries, collecting conflicts.
 */
export function buildRegistry(entries: BarcodeEntry[]): {
  registry: Map<string, string>;
  conflicts: Array<{ barcode: string; existingProductId: string }>;
} {
  const registry = new Map<string, string>();
  const conflicts: Array<{ barcode: string; existingProductId: string }> = [];

  for (const entry of entries) {
    const result = registerBarcode(registry, entry);
    if (!result.ok) {
      conflicts.push(result.conflict);
    }
  }

  return { registry, conflicts };
}

// ---------------------------------------------------------------------------
// Property 12: each registered barcode resolves to exactly one product
//
// Feature: ai-inventory-manager, Property 12: Barcode Resolution Uniqueness
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 12: Barcode Resolution Uniqueness
  'each barcode in the registry resolves to exactly one product',
  () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            barcode: fc.string({ minLength: 4, maxLength: 20 }),
            productId: fc.uuid(),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (entries) => {
          const { registry } = buildRegistry(entries);

          // For every barcode in the final registry there is exactly one mapping
          for (const [barcode, productId] of registry) {
            const resolved = resolveBarcode(registry, barcode);
            expect(resolved).not.toBeNull();
            expect(resolved).toBe(productId);
          }

          // No barcode should map to two different products
          const uniqueProductsPerBarcode = new Map<string, Set<string>>();
          for (const [barcode, productId] of registry) {
            if (!uniqueProductsPerBarcode.has(barcode)) {
              uniqueProductsPerBarcode.set(barcode, new Set());
            }
            uniqueProductsPerBarcode.get(barcode)!.add(productId);
          }

          for (const [, products] of uniqueProductsPerBarcode) {
            expect(products.size).toBe(1);
          }
        },
      ),
      { numRuns: 100, verbose: true, seed: 1200 },
    );
  },
);

// ---------------------------------------------------------------------------
// Property 12: duplicate barcode assignment to a different product is rejected
//
// Feature: ai-inventory-manager, Property 12: Barcode Resolution Uniqueness
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 12: Barcode Resolution Uniqueness
  'registering a barcode to a second different product is rejected',
  () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 4, maxLength: 20 }), // shared barcode
        fc.uuid(),  // first product
        fc.uuid(),  // second (different) product
        (barcode, productA, productB) => {
          // Skip if both UUIDs happen to collide (extremely unlikely)
          fc.pre(productA !== productB);

          const registry = new Map<string, string>();

          // First registration succeeds
          const first = registerBarcode(registry, { barcode, productId: productA });
          expect(first.ok).toBe(true);

          // Second registration of same barcode to a different product fails
          const second = registerBarcode(registry, { barcode, productId: productB });
          expect(second.ok).toBe(false);
          if (!second.ok) {
            expect(second.conflict.barcode).toBe(barcode);
            expect(second.conflict.existingProductId).toBe(productA);
          }

          // Registry still resolves to the original product
          expect(resolveBarcode(registry, barcode)).toBe(productA);
        },
      ),
      { numRuns: 100, verbose: true, seed: 1201 },
    );
  },
);

// ---------------------------------------------------------------------------
// Property 12: re-registering a barcode to the SAME product is idempotent
//
// Feature: ai-inventory-manager, Property 12: Barcode Resolution Uniqueness
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 12: Barcode Resolution Uniqueness
  're-registering a barcode to the same product succeeds (idempotent)',
  () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 4, maxLength: 20 }),
        fc.uuid(),
        fc.integer({ min: 2, max: 5 }), // repeat count
        (barcode, productId, n) => {
          const registry = new Map<string, string>();

          for (let i = 0; i < n; i++) {
            const result = registerBarcode(registry, { barcode, productId });
            expect(result.ok).toBe(true);
          }

          expect(resolveBarcode(registry, barcode)).toBe(productId);
        },
      ),
      { numRuns: 100, verbose: true, seed: 1202 },
    );
  },
);

// ---------------------------------------------------------------------------
// Edge case: unknown barcode resolves to null
// ---------------------------------------------------------------------------

test('unregistered barcode resolves to null', () => {
  const registry = new Map<string, string>();
  expect(resolveBarcode(registry, 'NOTREGISTERED')).toBeNull();
});
