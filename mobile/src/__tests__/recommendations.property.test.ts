// Feature: ai-inventory-manager
// Property 16: Reorder Quantity Calculation Correctness
// Property 17: Dead Stock Detection Completeness
//
// Validates: Requirements 11.6, 11.7
//
// Pure-logic property tests — no Supabase, no network.
// Mirrors the heuristics defined in the AI Recommendation Architecture section
// of the design document.

import fc from 'fast-check';

// ---------------------------------------------------------------------------
// Pure helpers — mirror the ai-recommendations Edge Function heuristics
// ---------------------------------------------------------------------------

export interface ReorderInputs {
  current_balance: number;
  reorder_point: number;
  safety_stock: number;
  lead_time_days: number;
  /** Daily sales velocity over the last 30 days */
  velocity_30d: number;
  open_po_qty: number;
  /** Supplier minimum order quantity */
  moq: number;
}

export interface ReorderResult {
  /** Whether a reorder recommendation should be generated */
  should_reorder: boolean;
  /** Suggested quantity (only meaningful when should_reorder === true) */
  suggested_qty: number;
}

/**
 * Compute the reorder suggestion following the design-doc heuristic:
 *
 *   projected_balance = current_balance + open_po_qty
 *                       - (velocity_30d * lead_time_days)
 *
 *   IF projected_balance <= reorder_point THEN
 *     suggested_qty = (velocity_30d * 28) + safety_stock
 *                     - current_balance - open_po_qty
 *     suggested_qty = MAX(suggested_qty, moq)
 *     suggested_qty = MAX(suggested_qty, 0)   -- never negative
 */
export function computeReorderSuggestion(inputs: ReorderInputs): ReorderResult {
  const {
    current_balance,
    reorder_point,
    safety_stock,
    lead_time_days,
    velocity_30d,
    open_po_qty,
    moq,
  } = inputs;

  const projected =
    current_balance + open_po_qty - velocity_30d * lead_time_days;

  if (projected > reorder_point) {
    return { should_reorder: false, suggested_qty: 0 };
  }

  const raw_qty =
    velocity_30d * 28 + safety_stock - current_balance - open_po_qty;

  const suggested_qty = Math.max(raw_qty, moq, 0);

  return { should_reorder: true, suggested_qty };
}

export interface DeadStockInputs {
  /** Days since the last sale movement for this SKU */
  days_since_last_sale: number;
  /** Current on-hand balance */
  balance: number;
}

/**
 * Returns true when the SKU qualifies as dead stock (design-doc rule:
 * days_since_last_sale >= 60 AND balance > 0).
 */
export function isDeadStock(inputs: DeadStockInputs): boolean {
  return inputs.days_since_last_sale >= 60 && inputs.balance > 0;
}

// ---------------------------------------------------------------------------
// Property 16: Reorder Quantity Calculation Correctness
//
// Feature: ai-inventory-manager, Property 16: Reorder Quantity Calculation Correctness
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 16: Reorder Quantity Calculation Correctness
  'suggested_qty >= MOQ and >= 0 when a reorder recommendation is generated',
  () => {
    fc.assert(
      fc.property(
        fc.record({
          current_balance: fc.float({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
          reorder_point: fc.float({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
          safety_stock: fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
          lead_time_days: fc.integer({ min: 0, max: 60 }),
          velocity_30d: fc.float({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }),
          open_po_qty: fc.float({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
          moq: fc.float({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true }),
        }),
        (inputs) => {
          const result = computeReorderSuggestion(inputs);

          if (result.should_reorder) {
            expect(result.suggested_qty).toBeGreaterThanOrEqual(inputs.moq);
            expect(result.suggested_qty).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 100, verbose: true, seed: 1600 },
    );
  },
);

test(
  // Feature: ai-inventory-manager, Property 16: Reorder Quantity Calculation Correctness
  'suggested_qty is non-negative for all valid inputs',
  () => {
    fc.assert(
      fc.property(
        fc.record({
          current_balance: fc.float({ min: 0, max: 1_000, noNaN: true, noDefaultInfinity: true }),
          reorder_point: fc.float({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
          safety_stock: fc.float({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
          lead_time_days: fc.integer({ min: 0, max: 90 }),
          velocity_30d: fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
          open_po_qty: fc.float({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
          moq: fc.float({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
        }),
        (inputs) => {
          const result = computeReorderSuggestion(inputs);
          expect(result.suggested_qty).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100, verbose: true, seed: 1601 },
    );
  },
);

// ---------------------------------------------------------------------------
// Property 17: Dead Stock Detection Completeness
//
// Feature: ai-inventory-manager, Property 17: Dead Stock Detection Completeness
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 17: Dead Stock Detection Completeness
  'dead stock is flagged when last_sale_days > 60 and balance > 0',
  () => {
    fc.assert(
      fc.property(
        // Generate inputs that satisfy the dead-stock preconditions
        fc.integer({ min: 61, max: 730 }),        // days_since_last_sale > 60
        fc.float({ min: Math.fround(0.0001), max: 10_000, noNaN: true, noDefaultInfinity: true }), // balance > 0
        (daysSinceLastSale, balance) => {
          const result = isDeadStock({ days_since_last_sale: daysSinceLastSale, balance });
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100, verbose: true, seed: 1700 },
    );
  },
);

test(
  // Feature: ai-inventory-manager, Property 17: Dead Stock Detection Completeness
  'dead stock is NOT flagged when balance is 0 (even with old last sale)',
  () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 61, max: 730 }), // days_since_last_sale > 60
        (daysSinceLastSale) => {
          const result = isDeadStock({ days_since_last_sale: daysSinceLastSale, balance: 0 });
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100, verbose: true, seed: 1701 },
    );
  },
);

test(
  // Feature: ai-inventory-manager, Property 17: Dead Stock Detection Completeness
  'dead stock is NOT flagged when sale is recent (< 60 days), even with positive balance',
  () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59 }), // days_since_last_sale < 60
        fc.float({ min: Math.fround(0.0001), max: 10_000, noNaN: true, noDefaultInfinity: true }), // balance > 0
        (daysSinceLastSale, balance) => {
          const result = isDeadStock({ days_since_last_sale: daysSinceLastSale, balance });
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100, verbose: true, seed: 1702 },
    );
  },
);
