/**
 * Zustand store for sync-on-reconnect.
 *
 * On store initialisation the module subscribes to NetInfo connectivity
 * events. When connectivity is restored and there are pending actions in
 * the offline queue, `processPendingActions()` is triggered automatically.
 *
 * Each action is dispatched FIFO to its corresponding Edge Function via
 * `supabase.functions.invoke`.  Successful actions are removed from the
 * queue; failed ones are marked with `status: 'failed'`.
 */

import NetInfo from '@react-native-community/netinfo';
import { create } from 'zustand';

import {
  clearQueue,
  dequeueNextAction,
  getPendingActions,
  markActionFailed,
} from '@/lib/offlineQueue';
import { supabase } from '@/lib/supabase';
import type { OfflineAction } from '@/types';

import { useOfflineQueueStore } from './offlineQueueStore';

// ---------------------------------------------------------------------------
// Edge Function name map
// ---------------------------------------------------------------------------

const EDGE_FUNCTION_MAP: Record<OfflineAction['type'], string> = {
  receive: 'receive-stock',
  adjustment: 'adjust-stock',
  count_line: 'submit-count-line',
  sale_manual: 'record-sale',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncState {
  /** True while the sync loop is actively running. */
  isSyncing: boolean;
  /** ISO 8601 timestamp of the last successful sync completion, or null. */
  lastSyncedAt: string | null;
  /** Whether the device currently has network connectivity. */
  isConnected: boolean;
}

interface SyncActions {
  /**
   * Process all queued offline actions in FIFO order.
   * Safe to call multiple times — a guard prevents concurrent runs.
   */
  processPendingActions: () => Promise<void>;
  /**
   * Manually update connectivity state (exposed for testing / manual override).
   */
  setIsConnected: (connected: boolean) => void;
}

type SyncStore = SyncState & SyncActions;

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useSyncStore = create<SyncStore>((set, get) => {
  // ---- initialise NetInfo listener ----------------------------------------
  // We schedule this after the store is created so the reference to `get` is
  // available.  The subscription is kept for the app's lifetime.
  let unsubscribeNetInfo: (() => void) | null = null;

  // Defer subscription setup to the next microtask so the store object is
  // fully created before the callback may fire.
  Promise.resolve().then(() => {
    unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      const connected = state.isConnected === true && state.isInternetReachable !== false;
      const wasConnected = get().isConnected;

      set({ isConnected: connected });

      // Trigger sync when transitioning from offline → online
      if (connected && !wasConnected) {
        void get().processPendingActions();
      }
    });
  });

  return {
    // ---- initial state ----
    isSyncing: false,
    lastSyncedAt: null,
    isConnected: true, // optimistic; NetInfo will correct immediately

    // ---- actions ----

    setIsConnected: (connected) => {
      set({ isConnected: connected });
    },

    processPendingActions: async () => {
      // Guard: don't run concurrently
      if (get().isSyncing) return;

      const pending = getPendingActions();
      if (pending.length === 0) return;

      // Notify the queue store so UI shows syncing badge
      set({ isSyncing: true });
      useOfflineQueueStore.getState().setIsSyncing(true);

      try {
        // Process actions FIFO; read one at a time so we always process the
        // current front of the queue after each successful dequeue.
        let action: OfflineAction | null;

        while ((action = dequeueNextAction()) !== null) {
          const fnName = EDGE_FUNCTION_MAP[action.type];
          if (!fnName) {
            // Unknown action type — mark failed and skip
            markActionFailed(action.id);
            continue;
          }

          try {
            const { error } = await supabase.functions.invoke(fnName, {
              body: {
                ...action.payload,
                idempotency_key: action.id,
              },
            });

            if (error) {
              // Put the action back with incremented retry count and mark failed
              markActionFailed(action.id);
            }
            // On success the action has already been removed by `dequeueNextAction`
          } catch {
            markActionFailed(action.id);
          }
        }

        set({ lastSyncedAt: new Date().toISOString() });
      } finally {
        set({ isSyncing: false });
        useOfflineQueueStore.getState().setIsSyncing(false);
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Cleanup export (for testing / hot-reload scenarios)
// ---------------------------------------------------------------------------
// The unsubscribeNetInfo reference is internal; this export is intentionally
// omitted — the listener lives for the app's lifetime.
