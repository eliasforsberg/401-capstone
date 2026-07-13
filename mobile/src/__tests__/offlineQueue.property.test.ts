// Feature: ai-inventory-manager
// Property 20: Offline Queue Idempotency
//
// Validates: Requirements 13.7
//
// Pure-logic property tests for the offline queue helpers.
// No network calls or Supabase involvement — everything runs in-memory.

import fc from 'fast-check';

// ---------------------------------------------------------------------------
// In-memory MMKV mock (avoids the react-native-mmkv native module)
// ---------------------------------------------------------------------------

const mmkvStore = new Map<string, string>();

jest.mock('react-native-mmkv', () => ({
  MMKV: jest.fn().mockImplementation(() => ({
    getString: (key: string) => mmkvStore.get(key) ?? undefined,
    set: (key: string, value: string) => mmkvStore.set(key, value),
    delete: (key: string) => mmkvStore.delete(key),
  })),
}));

// Import AFTER mock is registered so the module picks up the mock
import {
  enqueueAction,
  dequeueNextAction,
  getPendingActions,
  clearQueue,
} from '@/lib/offlineQueue';
import type { OfflineAction } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAction(id: string, overrides: Partial<OfflineAction> = {}): OfflineAction {
  return {
    id,
    type: 'adjustment',
    payload: { note: 'test' },
    createdAt: new Date().toISOString(),
    retryCount: 0,
    status: 'pending',
    ...overrides,
  };
}

beforeEach(() => {
  mmkvStore.clear();
  clearQueue();
});

// ---------------------------------------------------------------------------
// Property 20: Offline Queue Idempotency — idempotency key uniqueness
//
// Feature: ai-inventory-manager, Property 20: Offline Queue Idempotency
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 20: Offline Queue Idempotency
  'enqueuing the same idempotency key N times results in N entries (queue stores all, server dedupes)',
  () => {
    fc.assert(
      fc.property(
        // Generate a unique id and repeat count between 2 and 10
        fc.uuid(),
        fc.integer({ min: 2, max: 10 }),
        (id, repeatCount) => {
          clearQueue();
          mmkvStore.clear();
          const action = makeAction(id);

          for (let i = 0; i < repeatCount; i++) {
            enqueueAction(action);
          }

          const queued = getPendingActions();
          // The queue faithfully stores everything enqueued; server-side
          // offline_queue_log is what enforces idempotency via the unique
          // idempotency_key constraint.  The property here is that the queue
          // preserves every enqueue call — no silent deduplication on the
          // client side.
          expect(queued.length).toBe(repeatCount);
          // All entries share the same idempotency key
          expect(queued.every((a) => a.id === id)).toBe(true);
        },
      ),
      { numRuns: 100, verbose: true, seed: 42 },
    );
  },
);

// ---------------------------------------------------------------------------
// Round-trip: enqueue → dequeue FIFO order
//
// Feature: ai-inventory-manager, Property 20: Offline Queue Idempotency
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 20: Offline Queue Idempotency
  'dequeueNextAction returns actions in FIFO order',
  () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 20 }),
        (ids) => {
          clearQueue();
          mmkvStore.clear();

          const actions = ids.map((id) => makeAction(id));
          for (const a of actions) {
            enqueueAction(a);
          }

          const dequeued: OfflineAction[] = [];
          let next: OfflineAction | null;
          while ((next = dequeueNextAction()) !== null) {
            dequeued.push(next);
          }

          expect(dequeued.map((a) => a.id)).toEqual(ids);
        },
      ),
      { numRuns: 100, verbose: true, seed: 43 },
    );
  },
);

// ---------------------------------------------------------------------------
// After dequeue, queue shrinks by exactly 1
//
// Feature: ai-inventory-manager, Property 20: Offline Queue Idempotency
// ---------------------------------------------------------------------------

test(
  // Feature: ai-inventory-manager, Property 20: Offline Queue Idempotency
  'dequeueNextAction removes exactly one entry from the front',
  () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 30 }),
        (ids) => {
          clearQueue();
          mmkvStore.clear();

          for (const id of ids) {
            enqueueAction(makeAction(id));
          }

          const before = getPendingActions().length;
          const popped = dequeueNextAction();

          expect(popped).not.toBeNull();
          expect(popped?.id).toBe(ids[0]);
          expect(getPendingActions().length).toBe(before - 1);
        },
      ),
      { numRuns: 100, verbose: true, seed: 44 },
    );
  },
);

// ---------------------------------------------------------------------------
// dequeueNextAction on empty queue returns null (edge case)
// ---------------------------------------------------------------------------

test('dequeueNextAction returns null on empty queue', () => {
  clearQueue();
  mmkvStore.clear();
  expect(dequeueNextAction()).toBeNull();
});
