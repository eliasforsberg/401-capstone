/**
 * Zustand store that exposes the offline queue state to the UI layer.
 *
 * The store wraps the `offlineQueue` lib functions so React components can
 * react to changes in the pending action count and syncing status without
 * reading MMKV directly.
 */

import { create } from 'zustand';

import {
  enqueueAction,
  getPendingActions,
} from '@/lib/offlineQueue';
import type { OfflineAction } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OfflineQueueState {
  /** Number of actions currently waiting to be synced. */
  pendingCount: number;
  /** True while the sync loop is actively processing actions. */
  isSyncing: boolean;
}

interface OfflineQueueActions {
  /**
   * Serialize an action to MMKV and increment `pendingCount`.
   */
  enqueue: (action: OfflineAction) => void;
  /**
   * Re-read the queue from MMKV and refresh `pendingCount`.
   * Useful to call after a sync cycle completes.
   */
  getCount: () => number;
  /**
   * Set the syncing flag (called by `syncStore` when it starts / stops).
   */
  setIsSyncing: (syncing: boolean) => void;
}

type OfflineQueueStore = OfflineQueueState & OfflineQueueActions;

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useOfflineQueueStore = create<OfflineQueueStore>((set, get) => ({
  // ---- initial state ----
  pendingCount: getPendingActions().length,
  isSyncing: false,

  // ---- actions ----

  enqueue: (action) => {
    enqueueAction(action);
    // Reflect the updated count immediately
    set({ pendingCount: getPendingActions().length });
  },

  getCount: () => {
    const count = getPendingActions().length;
    set({ pendingCount: count });
    return count;
  },

  setIsSyncing: (syncing) => {
    set({ isSyncing: syncing });
    // When syncing completes, refresh the displayed count
    if (!syncing) {
      set({ pendingCount: getPendingActions().length });
    }
  },
}));
