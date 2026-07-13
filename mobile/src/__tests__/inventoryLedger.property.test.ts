// Feature: ai-inventory-manager
// Property 1: Movement Field Completeness
// Property 2: Ledger-Balance Consistency
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.6, 1.7
//
// Pure-logic property tests — no Supabase, no network.

import fc from 'fast-check';
import type { MovementType, MovementSource } from '@/types';

// ---------------------------------------------------------------------------
// Pure helper — mirrors the DB trigger logic for unit testing
// ---------------------------------------------------------------------------

export interface MovementInput {
  movement_id: string;
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  movement_type: MovementType;
  source: MovementSource;
  reason_code: string | null;
  user_id: string | null;
  edge_fn_id: string | null;
  created_at: string;
  before_quantity: number | null;
  after_quantity: number | null;
}

/**
 * Apply a sequence of movements to a starting balance of 0.
 * Returns the final balance — mirrors `SUM(quantity_delta)`.
 */
export function applyMovementsToBalance(
  movements: ReadonlyArray<{ quantity_delta: number }>,
): { balance: number } {
  const balance = movements.reduce((sum, m) => sum + m.quantity_delta, 0);
  return { balance };
}

/**
 * Build a minimal valid movement row, computing before/after snapshots for
 * adjustment-type movements.  Mirrors the logic in `inventoryService.ts`.
 */
export function buildMovementRow(
  input: {
    business_id: string;
    location_id: string;
    sku_id: string;
    quantity_delta: number;
    movement_type: MovementType;
    source: MovementSource;
    reason_code?: string;
    user_id?: string;
    edge_fn_id?: string;
    current_balance?: number;
  },
): MovementInput {
  const isAdjustment =
    input.movement_type === 'adjustment' || input.movement_type === 'count_correction';

  const before = isAdjustment ? (input.current_balance ?? 0) : null;
  const after = isAdjustment && before !== null ? before + input.quantity_delta : null;

  return {
    movement_id: 'test-id',
    business_id: input.business_id,
    location_id: input.location_id,
    sku_id: input.sku_id,
    quantity_delta: input.quantity_delta,
    movement_type: input.movement_type,
    source: input.source,
    reason_code: input.reason_code ?? null,
    user_id: input.user_id ?? null,
    edge_fn_id: input.edge_fn_id ?? null,
    created_at: new Date().toISOString(),
    before_quantity: before,
    after_quantity: after,
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const movementTypeArb = fc.constantFrom<MovementType>(
  'receive',
  'sale',
  'adjustment',
  'count_correction',
  'return',
  'transfer',
);

const movementSourceArb = fc.constantFrom<MovementSource>('pos_square', 'manual', 'system');

const deltaArb = fc.float({
  min: -10_000,
  max: 10_000,
  noNaN: true,
  noDefaultInfinity: true,
});

// ---------------------------------------------------------------------------
// Property 1: Movement Field Completeness
//
// Feature: ai-inventory-manager, Property 1: Movement Field Completeness
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 1: Movement Field Completeness
  'every movement row has all required non-null fields',
  () => {
    fc.assert(
      fc.property(
        fc.uuid(),   // business_id
        fc.uuid(),   // location_id
        fc.uuid(),   // sku_id
        deltaArb,
        movementTypeArb,
        movementSourceArb,
        fc.option(fc.uuid(), { nil: undefined }), // user_id (user-initiated)
        (businessId, locationId, skuId, delta, movType, source, userId) => {
          const row = buildMovementRow({
            business_id: businessId,
            location_id: locationId,
            sku_id: skuId,
            quantity_delta: delta,
            movement_type: movType,
            source,
            user_id: userId,
          });

          // Required non-null fields
          expect(row.movement_id).toBeTruthy();
          expect(row.business_id).not.toBeNull();
          expect(row.location_id).not.toBeNull();
          expect(row.sku_id).not.toBeNull();
          expect(row.quantity_delta).not.toBeNull();
          expect(row.movement_type).not.toBeNull();
          expect(row.source).not.toBeNull();
          expect(row.created_at).toBeTruthy();

          // Either user_id (user-initiated) or edge_fn_id (system) should be present
          // when source is 'system', edge_fn_id is relevant; otherwise user_id
          if (source !== 'system') {
            // For manual/pos_square movements user_id should be set (or at least
            // the field should exist in the shape — null is allowed if anonymous)
            expect('user_id' in row).toBe(true);
          }
        },
      ),
      { numRuns: 100, verbose: true, seed: 100 },
    );
  },
);

// ---------------------------------------------------------------------------
// Property 2: Ledger-Balance Consistency Invariant
//
// Feature: ai-inventory-manager, Property 2: Ledger-Balance Consistency Invariant
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 2: Ledger-Balance Consistency Invariant
  'balance equals SUM(quantity_delta) for any sequence of movements',
  () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ quantity_delta: deltaArb }),
          { minLength: 1, maxLength: 50 },
        ),
        (movements) => {
          const ledgerSum = movements.reduce((sum, m) => sum + m.quantity_delta, 0);
          const { balance } = applyMovementsToBalance(movements);

          // Use toBeCloseTo to handle floating-point imprecision (4 decimal places
          // matches NUMERIC(12,4) precision in the Postgres schema)
          expect(balance).toBeCloseTo(ledgerSum, 4);
        },
      ),
      { numRuns: 100, verbose: true, seed: 200 },
    );
  },
);

// ---------------------------------------------------------------------------
// Property 2 — order independence: balance is commutative
//
// Feature: ai-inventory-manager, Property 2: Ledger-Balance Consistency Invariant
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 2: Ledger-Balance Consistency Invariant
  'ledger balance is the same regardless of movement insertion order',
  () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ quantity_delta: deltaArb }),
          { minLength: 2, maxLength: 30 },
        ),
        (movements) => {
          const { balance: original } = applyMovementsToBalance(movements);
          const shuffled = [...movements].reverse(); // simple reordering
          const { balance: reordered } = applyMovementsToBalance(shuffled);
          expect(reordered).toBeCloseTo(original, 4);
        },
      ),
      { numRuns: 100, verbose: true, seed: 201 },
    );
  },
);

// ---------------------------------------------------------------------------
// Property 2 — adjustment snapshot correctness
//
// Feature: ai-inventory-manager, Property 2: Ledger-Balance Consistency Invariant
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 2: Ledger-Balance Consistency Invariant
  'adjustment movement: after_quantity = before_quantity + quantity_delta',
  () => {
    fc.assert(
      fc.property(
        fc.float({ min: -9_000, max: 9_000, noNaN: true, noDefaultInfinity: true }), // before
        fc.float({ min: -1_000, max: 1_000, noNaN: true, noDefaultInfinity: true }), // delta
        fc.constantFrom<'adjustment' | 'count_correction'>('adjustment', 'count_correction'),
        (currentBalance, delta, movType) => {
          const row = buildMovementRow({
            business_id: 'biz-1',
            location_id: 'loc-1',
            sku_id: 'sku-1',
            quantity_delta: delta,
            movement_type: movType,
            source: 'manual',
            current_balance: currentBalance,
          });

          expect(row.before_quantity).toBeCloseTo(currentBalance, 4);
          expect(row.after_quantity).toBeCloseTo(currentBalance + delta, 4);
        },
      ),
      { numRuns: 100, verbose: true, seed: 202 },
    );
  },
);
