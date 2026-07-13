/**
 * TanStack Query v5 hooks for alerts.
 *
 * Provides:
 *   useAlerts()           — fetch active alerts for the current business
 *   useAlertsRealtime()   — Supabase Realtime subscription that keeps the
 *                           TanStack Query cache up-to-date on INSERT events
 *   useAcknowledgeAlert() — mutation to acknowledge an active alert
 *
 * Requirements: 4.3, 4.6
 */

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { AlertStatus, AlertType } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Alert {
  alert_id: string;
  business_id: string;
  location_id: string;
  sku_id: string | null;
  alert_type: AlertType;
  status: AlertStatus;
  message: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_at: string;
  /** Joined product name — present when the query includes a products join. */
  sku_name?: string | null;
}

/** Payload shape for an INSERT Realtime event on the alerts table. */
interface AlertRealtimePayload {
  new: Alert;
}

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

/** `['alerts', businessId]` */
const alertsKey = (businessId: string) => ['alerts', businessId] as const;

// ---------------------------------------------------------------------------
// useAlerts
// ---------------------------------------------------------------------------

/**
 * Fetches all non-resolved alerts for the current business, ordered newest-first.
 * Includes a joined `sku_name` from the products table for display purposes.
 *
 * Requirements: 4.3, 4.6
 */
export function useAlerts() {
  const businessId = useAuthStore((s) => s.businessId);

  return useQuery<Alert[]>({
    queryKey: alertsKey(businessId ?? ''),
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('alerts')
        .select(
          `alert_id,
           business_id,
           location_id,
           sku_id,
           alert_type,
           status,
           message,
           acknowledged_by,
           acknowledged_at,
           resolved_at,
           created_at,
           products(name)`
        )
        .eq('business_id', businessId!)
        .neq('status', 'resolved')
        .order('created_at', { ascending: false });

      if (error) throw error;

      return ((data ?? []) as any[]).map((row) => ({
        alert_id: row.alert_id as string,
        business_id: row.business_id as string,
        location_id: row.location_id as string,
        sku_id: row.sku_id as string | null,
        alert_type: row.alert_type as AlertType,
        status: row.status as AlertStatus,
        message: row.message as string | null,
        acknowledged_by: row.acknowledged_by as string | null,
        acknowledged_at: row.acknowledged_at as string | null,
        resolved_at: row.resolved_at as string | null,
        created_at: row.created_at as string,
        sku_name: (row.products as { name: string } | null)?.name ?? null,
      }));
    },
  });
}

// ---------------------------------------------------------------------------
// useAlertsRealtime
// ---------------------------------------------------------------------------

/**
 * Subscribes to Supabase Realtime INSERT events on the alerts table for the
 * current business.  When a new alert arrives, it is prepended to the
 * TanStack Query cache so the UI updates without a full refetch.
 *
 * Mount this hook alongside `useAlerts()` on any screen that should receive
 * live updates.  It cleans up the channel on unmount.
 *
 * Requirements: 4.3
 */
export function useAlertsRealtime() {
  const businessId = useAuthStore((s) => s.businessId);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!businessId) return;

    const channel = supabase
      .channel(`alerts:business_id=eq.${businessId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'alerts',
          filter: `business_id=eq.${businessId}`,
        },
        (payload: AlertRealtimePayload) => {
          const newAlert: Alert = {
            ...payload.new,
            // sku_name is not available from the raw DB payload; the full list
            // re-fetch will populate it.  Prepend with null for immediate display.
            sku_name: null,
          };

          queryClient.setQueryData<Alert[]>(
            alertsKey(businessId),
            (prev) => {
              // Skip if alert already exists in cache (duplicate safety)
              if (prev?.some((a) => a.alert_id === newAlert.alert_id)) {
                return prev;
              }
              return [newAlert, ...(prev ?? [])];
            }
          );

          // Invalidate to pull in the joined sku_name on the next background refetch
          void queryClient.invalidateQueries({ queryKey: alertsKey(businessId) });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [businessId, queryClient]);
}

// ---------------------------------------------------------------------------
// useAcknowledgeAlert
// ---------------------------------------------------------------------------

/**
 * Mutation that transitions an alert from `active` → `acknowledged` and
 * records the acknowledging user + timestamp.
 *
 * Requirements: 4.6
 */
export function useAcknowledgeAlert() {
  const businessId = useAuthStore((s) => s.businessId);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (alertId: string) => {
      const { error } = await supabase
        .from('alerts')
        .update({
          status: 'acknowledged' as AlertStatus,
          acknowledged_by: userId,
          acknowledged_at: new Date().toISOString(),
        })
        .eq('alert_id', alertId)
        .eq('business_id', businessId!);

      if (error) throw error;
    },

    // Optimistic update: flip status in cache immediately
    onMutate: async (alertId: string) => {
      const key = alertsKey(businessId ?? '');
      await queryClient.cancelQueries({ queryKey: key });

      const previous = queryClient.getQueryData<Alert[]>(key);

      queryClient.setQueryData<Alert[]>(key, (prev) =>
        (prev ?? []).map((a) =>
          a.alert_id === alertId
            ? {
                ...a,
                status: 'acknowledged' as AlertStatus,
                acknowledged_by: userId,
                acknowledged_at: new Date().toISOString(),
              }
            : a
        )
      );

      return { previous, key };
    },

    onError: (
      _err,
      _alertId,
      context: { previous: Alert[] | undefined; key: readonly unknown[] } | undefined
    ) => {
      if (context) {
        queryClient.setQueryData(context.key, context.previous);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: alertsKey(businessId ?? '') });
    },
  });
}
