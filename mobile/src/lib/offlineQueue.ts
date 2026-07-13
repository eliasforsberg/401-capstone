/**
 * MMKV-backed offline action queue.
 *
 * All pending actions are stored as a JSON array under the single MMKV key
 * `'actions'` in an `'offline-queue'` instance.  The queue is FIFO: new
 * actions are appended to the end; `dequeueNextAction` removes from the front.
 *
 * On web, MMKV is not available (native module). We fall back to an
 * in-memory queue so the web build doesn't crash. Persistence is not
 * required for the web target.
 */

import { Platform } from 'react-native';

import type { OfflineAction } from '@/types';

// ---------------------------------------------------------------------------
// Storage abstraction: MMKV on native, in-memory on web
// ---------------------------------------------------------------------------

interface QueueStorage {
  getString: (key: string) => string | null;
  set: (key: string, value: string) => void;
  delete: (key: string) => void;
}

function createStorage(): QueueStorage {
  if (Platform.OS !== 'web') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
    return new MMKV({ id: 'offline-queue' });
  }
  // In-memory fallback for web
  const store = new Map<string, string>();
  return {
    getString: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value); },
    delete: (key) => { store.delete(key); },
  };
}

const storage = createStorage();
const QUEUE_KEY = 'actions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readQueue(): OfflineAction[] {
  const raw = storage.getString(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OfflineAction[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(actions: OfflineAction[]): void {
  storage.set(QUEUE_KEY, JSON.stringify(actions));
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
  storage.delete(QUEUE_KEY);
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

/**
 * Increment the `retryCount` for a specific action and reset its status back
 * to `'pending'` so it will be retried on the next sync pass.
 */
export function incrementRetryCount(id: string): void {
  const current = readQueue();
  const updated = current.map((action) =>
    action.id === id
      ? { ...action, retryCount: action.retryCount + 1, status: 'pending' as const }
      : action
  );
  writeQueue(updated);
}

/**
 * Re-insert a previously dequeued action at the back of the queue.
 * Used when an action must be kept for retry after a transient server error.
 */
export function requeueAction(action: OfflineAction): void {
  const current = readQueue();
  // Avoid duplicates — only add if not already present
  if (!current.some((a) => a.id === action.id)) {
    current.push(action);
    writeQueue(current);
  }
}
