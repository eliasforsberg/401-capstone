/**
 * MMKV-backed offline action queue.
 *
 * All pending actions are stored as a JSON array under the single MMKV key
 * `'actions'` in an `'offline-queue'` instance.  The queue is FIFO: new
 * actions are appended to the end; `dequeueNextAction` removes from the front.
 */

import { MMKV } from 'react-native-mmkv';

import type { OfflineAction } from '@/types';

// ---------------------------------------------------------------------------
// MMKV instance
// ---------------------------------------------------------------------------

const mmkv = new MMKV({ id: 'offline-queue' });

const QUEUE_KEY = 'actions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readQueue(): OfflineAction[] {
  const raw = mmkv.getString(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OfflineAction[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(actions: OfflineAction[]): void {
  mmkv.set(QUEUE_KEY, JSON.stringify(actions));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append an action to the end of the queue.
 */
export function enqueueAction(action: OfflineAction): void {
  const current = readQueue();
  current.push(action);
  writeQueue(current);
}

/**
 * Remove and return the oldest pending action (FIFO).
 * Returns `null` when the queue is empty.
 */
export function dequeueNextAction(): OfflineAction | null {
  const current = readQueue();
  if (current.length === 0) return null;
  const [next, ...rest] = current;
  writeQueue(rest);
  return next ?? null;
}

/**
 * Read all pending actions without modifying the queue.
 */
export function getPendingActions(): OfflineAction[] {
  return readQueue();
}

/**
 * Remove all actions from the queue.
 */
export function clearQueue(): void {
  mmkv.delete(QUEUE_KEY);
}

/**
 * Update the status of a specific action to `'failed'`.
 */
export function markActionFailed(id: string): void {
  const current = readQueue();
  const updated = current.map((action) =>
    action.id === id ? { ...action, status: 'failed' as const } : action
  );
  writeQueue(updated);
}
