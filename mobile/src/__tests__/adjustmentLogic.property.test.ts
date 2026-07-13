// Feature: ai-inventory-manager
// Property 9: Adjustment Reason Code and Snapshot Completeness
// Property 10: Approval Threshold Enforcement
//
// Validates: Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 5.7
//
// Pure-logic property tests — no Supabase, no network.

import fc from 'fast-check';
import type { ReasonCode } from '@/types';

// ---------------------------------------------------------------------------
// Pure helpers — mirror adjust-stock Edge Function logic
// ---------------------------------------------------------------------------

export const ALLOWED_REASON_CODES: ReadonlySet<ReasonCode> = new Set([
  'damage',
  'theft',
  'expiry',
  'counting_correction',
  'other',
]);

export interface AdjustmentInput {
  reason_code: ReasonCode;
  quantity_delta: number;
  before_quantity: number;
  notes?: string;
}

export interface AdjustmentMovementRow {
  reason_code: ReasonCode;
  before_quantity: number;
  after_quantity: number;
  quantity_delta: number;
}

export type AdjustmentSubmissionResult =
  | { outcome: 'immediate'; movement: AdjustmentMovementRow }
  | { outcome: 'pending_approval' };

/**
 * Build the movement row for an adjustment.
 * Mirrors the snapshot computation in inventoryService.ts.
 */
export function buildAdjustmentRow(input: AdjustmentInput): AdjustmentMovementRow {
  return {
    reason_code: input.reason_code,
    before_quantity: input.before_quantity,
    after_quantity: input.before_quantity + input.quantity_delta,
    quantity_delta: input.quantity_delta,
  };
}

/**
 * Determine the submission outcome based on the caller role, delta, and
 * business-configured approval threshold.
 *
 * Mirrors the logic in `supabase/functions/adjust-stock/index.ts`:
 *   - If role is 'staff' AND ABS(delta) > threshold → pending_approval
 *   - Otherwise → immediate
 */
export function submitAdjustment(
  input: AdjustmentInput,
  callerRole: 'owner' | 'staff' | 'purchasing' | 'accountant',
  approvalThreshold: number,
): AdjustmentSubmissionResult {
  const absQty = Math.abs(input.quantity_delta);

  if (callerRole === 'staff' && absQty > approvalThreshold) {
    return { outcome: 'pending_approval' };
  }

  return { outcome: 'immediate', movement: buildAdjustmentRow(input) };
}

// ---------------------------------------------------------------------------
// Property 9: Adjustment Snapshot Completeness
//
// Feature: ai-inventory-manager, Property 9: Adjustment Reason Code and Snapshot Completeness
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 9: Adjustment Reason Code and Snapshot Completeness
  'adjustment row has non-null reason_code, before_quantity, after_quantity and after = before + delta',
  () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ReasonCode>(...Array.from(ALLOWED_REASON_CODES)),
        fc.float({ min: -10_000, max: 10_000, noNaN: true, noDefaultInfinity: true }), // delta
        fc.float({ min: -5_000, max: 5_000, noNaN: true, noDefaultInfinity: true }),   // before
        (reasonCode, delta, before) => {
          const row = buildAdjustmentRow({
            reason_code: reasonCode,
            quantity_delta: delta,
            before_quantity: before,
          });

          // All required fields must be present and non-null
          expect(row.reason_code).not.toBeNull();
          expect(ALLOWED_REASON_CODES.has(row.reason_code)).toBe(true);
          expect(row.before_quantity).not.toBeNull();
          expect(row.after_quantity).not.toBeNull();

          // Core invariant: after_quantity = before_quantity + delta
          expect(row.after_quantity).toBeCloseTo(before + delta, 4);
        },
      ),
      { numRuns: 100, verbose: true, seed: 900 },
    );
  },
);

// ---------------------------------------------------------------------------
// Property 10: Approval Threshold Enforcement
//
// Feature: ai-inventory-manager, Property 10: Approval Threshold Enforcement
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 10: Approval Threshold Enforcement
  'staff submission where ABS(delta) > threshold results in pending_approval',
  () => {
    fc.assert(
      fc.property(
        // Generate threshold in a reasonable range
        fc.float({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true }),
        // Generate delta strictly exceeding threshold (positive side)
        fc.float({ min: Math.fround(0.0001), max: 500, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom<ReasonCode>(...Array.from(ALLOWED_REASON_CODES)),
        fc.float({ min: 0, max: 1_000, noNaN: true, noDefaultInfinity: true }),
        (threshold, excess, reasonCode, before) => {
          const delta = threshold + excess; // ABS(delta) is strictly > threshold

          const result = submitAdjustment(
            { reason_code: reasonCode, quantity_delta: delta, before_quantity: before },
            'staff',
            threshold,
          );

          expect(result.outcome).toBe('pending_approval');

          // Also verify with negative delta (same ABS value)
          const resultNeg = submitAdjustment(
            { reason_code: reasonCode, quantity_delta: -delta, before_quantity: before },
            'staff',
            threshold,
          );
          expect(resultNeg.outcome).toBe('pending_approval');
        },
      ),
      { numRuns: 100, verbose: true, seed: 1000 },
    );
  },
);

test(
  // Feature: ai-inventory-manager, Property 10: Approval Threshold Enforcement
  'owner or purchasing can submit any adjustment immediately (no threshold gate)',
  () => {
    fc.assert(
      fc.property(
        fc.float({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true }),  // threshold
        fc.float({ min: -10_000, max: 10_000, noNaN: true, noDefaultInfinity: true }), // delta (any size)
        fc.constantFrom<'owner' | 'purchasing'>('owner', 'purchasing'),
        fc.constantFrom<ReasonCode>(...Array.from(ALLOWED_REASON_CODES)),
        fc.float({ min: 0, max: 1_000, noNaN: true, noDefaultInfinity: true }),
        (threshold, delta, role, reasonCode, before) => {
          const result = submitAdjustment(
            { reason_code: reasonCode, quantity_delta: delta, before_quantity: before },
            role,
            threshold,
          );

          expect(result.outcome).toBe('immediate');
        },
      ),
      { numRuns: 100, verbose: true, seed: 1001 },
    );
  },
);

test(
  // Feature: ai-inventory-manager, Property 10: Approval Threshold Enforcement
  'staff submission where ABS(delta) <= threshold is processed immediately',
  () => {
    fc.assert(
      fc.property(
        // threshold > 0
        fc.float({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true }),
        // delta in range [0, threshold] (ABS <= threshold)
        fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom<ReasonCode>(...Array.from(ALLOWED_REASON_CODES)),
        fc.float({ min: 0, max: 1_000, noNaN: true, noDefaultInfinity: true }),
        (threshold, fraction, reasonCode, before) => {
          const delta = threshold * fraction; // ABS(delta) <= threshold

          const result = submitAdjustment(
            { reason_code: reasonCode, quantity_delta: delta, before_quantity: before },
            'staff',
            threshold,
          );

          expect(result.outcome).toBe('immediate');
        },
      ),
      { numRuns: 100, verbose: true, seed: 1002 },
    );
  },
);
