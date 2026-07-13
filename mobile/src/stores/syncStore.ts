/**
 * Zustand store for sync-on-reconnect.
 *
 * On store initialisation the module subscribes to NetInfo connectivity
 * events. When connectivity is restored and there are pending actions in
 * the offline queue, `processPendingActions()` is triggered automatically.
 *
 * Each action is dispatched FIFO to its corresponding Edge Function via
 * `supabase.functions.invoke`.
 *
 * Success path:   action is dequeued → TanStack Query caches are invalidated.
 * Conflict (409): action is flagged `status: 'failed'`; conflict detail is
 *                 recorded in `conflictErrors` so the UI can prompt retry/discard.
 * Server error:   `retryCount` is incremented; action is re-queued so it will
 *                 be retried on the next reconnect.
 *
 * Requirements: 13.4, 13.5, 13.6
 */

import { QueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
import { create } from 'zustand';

import {
  dequeueNextAction,
  getPendingActions,
  markActionFailed,
  requeueAction,
} from '@/lib/offlineQueue';
import { supabase } from '@/lib/supabase';
import type { OfflineAction } from '@/types';

import { useOfflineQueueStore } from './offlineQueueStore';

// ---------------------------------------------------------------------------
// Shared QueryClient — set once during app bootstrap via `setQueryClient`.
// We use a module-level reference so the store can invalidate caches without
// needing React context.
// ---------------------------------------------------------------------------

let _queryClient: QueryClient | null = null;

/**
 * Register the TanStack Query client so `syncStore` can invalidate caches
 * after a successful sync.  Call this once in your app root (e.g. in
 * `_layout.tsx` after creating the QueryClient).
 */
export function setQueryClient(qc: QueryClient): void {
  _queryClient = qc;
}

// ---------------------------------------------------------------------------
// Edge Function name map
// ---------------------------------------------------------------------------

const EDGE_FUNCTION_MAP: Record<OfflineAction['type'], string> = {
  receive: 'receive-stock',
  adjustment: 'adjust-stock',
  count_line: 'submit-count-line',
  sale_manual: 'record-sale',
};

/**
 * Query keys to invalidate after a successful sync, keyed by action type.
 * Each value is an array of TanStack Query key arrays to invalidate.
 */
const INVALIDATION_KEYS: Record<OfflineAction['type'], string[][]> = {
  receive: [['inventory', 'balances'], ['inventory', 'movements'], ['purchase-orders']],
  adjustment: [['inventory', 'balances'], ['inventory', 'movements']],
  count_line: [['inventory', 'balances'], ['inventory', 'movements'], ['count-sessions']],
  sale_manual: [['inventory', 'balances'], ['inventory', 'movements']],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A conflict or error surfaced to the UI after a failed sync attempt. */
export interface SyncError {
  /** The offline action that failed. */
  actionId: string;
  actionType: OfflineAction['type'];
  /** Human-readable description of what went wrong. */
  message: string;
  /**
   * 'conflict'   → 409 from the server; user must retry or discard.
   * 'server_error' → 5xx; action has been re-queued for automatic retry.
   */
  kind: 'conflict' | 'server_error';
}

interface SyncState {
  /** True while the sync loop is actively running. */
  isSyncing: boolean;
  /** ISO 8601 timestamp of the last successful sync completion, or null. */
  lastSyncedAt: string | null;
  /** Whether the device currently has network connectivity. */
  isConnected: boolean;
  /** Errors accumulated during the most recent sync pass. */
  syncErrors: SyncError[];
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
  /**
   * Clear a specific sync error after the user has acknowledged / retried it.
   */
  clearSyncError: (actionId: string) => void;
  /**
   * Clear all accumulated sync errors.
   */
  clearAllSyncErrors: () => void;
}

type SyncStore = SyncState & SyncActions;

// ---------------------------------------------------------------------------
// Helper: build a human-readable conflict message
// ---------------------------------------------------------------------------

function buildConflictMessage(actionType: OfflineAction['type'], detail?: string): string {
  const base: Record<OfflineAction['type'], string> = {
    receive: 'This receive could not be applied — the purchase order may have been modified.',
    adjustment: 'This stock adjustment conflicted with a more recent change on the server.',
    count_line: 'This count submission conflicted with a server-side update to the same SKU.',
    sale_manual: 'This manual sale conflicted with an existing transaction record.',
  };
  const msg = base[actionType] ?? 'This action conflicted with a server-side change.';
  return detail ? `${msg} Server detail: ${detail}` : msg;
}

function buildServerErrorMessage(actionType: OfflineAction['type']): string {
  const base: Record<OfflineAction['type'], string> = {
    receive: 'The server could not process your receive right now. It will be retried automatically.',
    adjustment: 'The server could not apply your adjustment right now. It will be retried automatically.',
    count_line: 'The server could not record your count submission right now. It will be retried automatically.',
    sale_manual: 'The server could not record your sale right now. It will be retried automatically.',
  };
  return base[actionType] ?? 'A server error occurred. The action will be retried automatically.';
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useSyncStore = create<SyncStore>((set, get) => {
  // ---- initialise NetInfo listener ----------------------------------------
  // We schedule this after the store is created so the reference to `get` is
  // available.  The subscription is kept for the app's lifetime.

  // Defer subscription setup to the next microtask so the store object is
  // fully created before the callback may fire.
  Promise.resolve().then(() => {
    if (Platform.OS === 'web') {
      // On web, use the browser's online/offline events instead of NetInfo.
      const handleOnline = () => {
        const wasConnected = get().isConnected;
        set({ isConnected: true });
        if (!wasConnected) {
          void get().processPendingActions();
        }
      };
      const handleOffline = () => { set({ isConnected: false }); };
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      // Set initial state from navigator
      set({ isConnected: navigator.onLine });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const NetInfo = require('@react-native-community/netinfo').default as typeof import('@react-native-community/netinfo').default;
      NetInfo.addEventListener((state) => {
        const connected = state.isConnected === true && state.isInternetReachable !== false;
        const wasConnected = get().isConnected;

        set({ isConnected: connected });

        // Trigger sync when transitioning from offline → online (Req 13.4)
        if (connected && !wasConnected) {
          void get().processPendingActions();
        }
      });
    }
  });

  return {
    // ---- initial state ----
    isSyncing: false,
    lastSyncedAt: null,
    isConnected: true, // optimistic; NetInfo will correct immediately
    syncErrors: [],

    // ---- actions ----

    setIsConnected: (connected) => {
      set({ isConnected: connected });
    },

    clearSyncError: (actionId) => {
      set((s) => ({ syncErrors: s.syncErrors.filter((e) => e.actionId !== actionId) }));
    },

    clearAllSyncErrors: () => {
      set({ syncErrors: [] });
    },

    processPendingActions: async () => {
      // Guard: don't run concurrently
      if (get().isSyncing) return;

      const pending = getPendingActions();
      if (pending.length === 0) return;

      // Clear previous errors before starting a new pass
      set({ isSyncing: true, syncErrors: [] });
      // Notify the queue store so UI shows syncing badge (Req 13.6)
      useOfflineQueueStore.getState().setIsSyncing(true);

      const newErrors: SyncError[] = [];

      try {
        // Process actions FIFO; read one at a time so we always process the
        // current front of the queue after each successful dequeue.
        let action: OfflineAction | null;

        while ((action = dequeueNextAction()) !== null) {
          const fnName = EDGE_FUNCTION_MAP[action.type];
          if (!fnName) {
            // Unknown action type — mark failed and skip
            markActionFailed(action.id);
            newErrors.push({
              actionId: action.id,
              actionType: action.type,
              message: `Unknown action type "${action.type}". Please discard this action.`,
              kind: 'conflict',
            });
            continue;
          }

          let httpStatus: number | undefined;
          let serverMessage: string | undefined;

          try {
            const result = await supabase.functions.invoke(fnName, {
              body: {
                ...action.payload,
                idempotency_key: action.id,
              },
            });

            // supabase-js wraps non-2xx responses in `result.error` but also
            // exposes the raw status via `result.error?.context?.status` or
            // through the fetch response stored on the error object.
            if (result.error) {
              // Try to extract HTTP status from the error context
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ctx = (result.error as any)?.context as Response | undefined;
              httpStatus = ctx?.status;
              serverMessage =
                typeof result.error.message === 'string' ? result.error.message : undefined;
            } else {
              // ---- SUCCESS ----
              // Invalidate affected TanStack Query caches so UI refreshes
              if (_queryClient) {
                const keysToInvalidate = INVALIDATION_KEYS[action.type] ?? [];
                for (const key of keysToInvalidate) {
                  void _queryClient.invalidateQueries({ queryKey: key });
                }
              }
              // Action was already removed from queue by dequeueNextAction — nothing else to do.
              continue;
            }
          } catch {
            // Network-level error — treat as server error
            httpStatus = undefined;
          }

          // ---- ERROR HANDLING ----

          if (httpStatus === 409) {
            // Conflict: flag as failed, surface to user for retry/discard (Req 13.5)
            markActionFailed(action.id);
            newErrors.push({
              actionId: action.id,
              actionType: action.type,
              message: buildConflictMessage(action.type, serverMessage),
              kind: 'conflict',
            });
          } else {
            // Server error (5xx) or network error: increment retryCount, re-queue (Req 13.5)
            const updatedAction: OfflineAction = {
              ...action,
              retryCount: action.retryCount + 1,
              status: 'pending',
            };
            // requeueAction checks for duplicates and only inserts if not present.
            // updatedAction already carries the incremented retryCount, so we do
            // NOT call incrementRetryCount separately to avoid double-counting.
            requeueAction(updatedAction);
            newErrors.push({
              actionId: action.id,
              actionType: action.type,
              message: buildServerErrorMessage(action.type),
              kind: 'server_error',
            });
          }
        }

        set({ lastSyncedAt: new Date().toISOString() });
      } finally {
        set({ isSyncing: false, syncErrors: newErrors });
        useOfflineQueueStore.getState().setIsSyncing(false);
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Cleanup export (for testing / hot-reload scenarios)
// ---------------------------------------------------------------------------
// The NetInfo unsubscribe reference is internal; the listener lives for the
// app's lifetime.
