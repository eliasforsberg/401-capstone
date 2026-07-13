/**
 * Admin Square Sync Events Screen
 * Shows failed and unmatched Square sync events for Owner investigation.
 * Requirements: 3.8
 */
import { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SquareSyncEvent {
  event_id: string;
  square_event_type: string;
  square_event_id: string;
  status: 'failed' | 'unmatched';
  error_message: string | null;
  retry_count: number;
  created_at: string;
  processed_at: string | null;
}

// ---------------------------------------------------------------------------
// Data fetching hooks
// ---------------------------------------------------------------------------

function useSquareSyncEvents(businessId: string | null) {
  return useQuery<SquareSyncEvent[]>({
    queryKey: ['square-sync-events', businessId, 'failed-unmatched'],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('square_sync_events')
        .select(
          'event_id, square_event_type, square_event_id, status, error_message, retry_count, created_at, processed_at'
        )
        .eq('business_id', businessId!)
        .in('status', ['failed', 'unmatched'])
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data ?? []) as SquareSyncEvent[];
    },
  });
}

function useRetryEvent(businessId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (eventId: string) => {
      // Re-queue by resetting status to pending and clearing error state
      const { error } = await supabase
        .from('square_sync_events')
        .update({
          status: 'pending',
          retry_count: 0,
          error_message: null,
          processed_at: null,
        })
        .eq('event_id', eventId)
        .eq('business_id', businessId!);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['square-sync-events', businessId],
      });
    },
  });
}

function useMarkResolved(businessId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (eventId: string) => {
      const { error } = await supabase
        .from('square_sync_events')
        .update({ status: 'resolved' as unknown as string })
        .eq('event_id', eventId)
        .eq('business_id', businessId!);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['square-sync-events', businessId],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusColor(status: string) {
  return status === 'failed' ? '#dc2626' : '#d97706';
}

// ---------------------------------------------------------------------------
// Event row component
// ---------------------------------------------------------------------------

interface EventRowProps {
  item: SquareSyncEvent;
  onRetry: (id: string) => void;
  onResolve: (id: string) => void;
  isRetrying: boolean;
  isResolving: boolean;
}

function EventRow({ item, onRetry, onResolve, isRetrying, isResolving }: EventRowProps) {
  return (
    <View style={styles.row}>
      {/* Status badge + event type */}
      <View style={styles.rowHeader}>
        <View style={[styles.badge, { backgroundColor: statusColor(item.status) }]}>
          <Text style={styles.badgeText}>{item.status.toUpperCase()}</Text>
        </View>
        <Text style={styles.eventType} numberOfLines={1}>
          {item.square_event_type}
        </Text>
      </View>

      {/* Event ID */}
      <Text style={styles.eventId} numberOfLines={1}>
        ID: {item.square_event_id}
      </Text>

      {/* Error message */}
      {item.error_message ? (
        <Text style={styles.errorMessage} numberOfLines={3}>
          {item.error_message}
        </Text>
      ) : null}

      {/* Metadata row */}
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>Retries: {item.retry_count}</Text>
        <Text style={styles.metaText}>{formatDate(item.created_at)}</Text>
      </View>

      {/* Action buttons */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, styles.retryButton]}
          onPress={() => onRetry(item.event_id)}
          disabled={isRetrying || isResolving}
          accessibilityLabel="Retry event"
          accessibilityRole="button"
        >
          {isRetrying ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Retry</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.resolveButton]}
          onPress={() => onResolve(item.event_id)}
          disabled={isRetrying || isResolving}
          accessibilityLabel="Mark as resolved"
          accessibilityRole="button"
        >
          {isResolving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Mark Resolved</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SquareEventsScreen() {
  const { businessId, role } = useAuthStore();
  const [refreshing, setRefreshing] = useState(false);
  const [actionEventId, setActionEventId] = useState<string | null>(null);
  const [actionType, setActionType] = useState<'retry' | 'resolve' | null>(null);

  const { data: events, isLoading, error, refetch } = useSquareSyncEvents(businessId);
  const retryMutation = useRetryEvent(businessId);
  const resolveMutation = useMarkResolved(businessId);

  // Owner-only guard
  if (role !== 'owner') {
    return (
      <View style={styles.centered}>
        <Text style={styles.accessDenied}>
          This screen is restricted to business owners.
        </Text>
      </View>
    );
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const handleRetry = (eventId: string) => {
    Alert.alert(
      'Retry Event',
      'Re-queue this event for processing?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Retry',
          onPress: () => {
            setActionEventId(eventId);
            setActionType('retry');
            retryMutation.mutate(eventId, {
              onSettled: () => {
                setActionEventId(null);
                setActionType(null);
              },
              onError: (err) => {
                Alert.alert('Error', `Failed to retry event: ${err.message}`);
              },
            });
          },
        },
      ]
    );
  };

  const handleResolve = (eventId: string) => {
    Alert.alert(
      'Mark Resolved',
      'Mark this event as manually resolved? This is a terminal action.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mark Resolved',
          style: 'destructive',
          onPress: () => {
            setActionEventId(eventId);
            setActionType('resolve');
            resolveMutation.mutate(eventId, {
              onSettled: () => {
                setActionEventId(null);
                setActionType(null);
              },
              onError: (err) => {
                Alert.alert('Error', `Failed to resolve event: ${err.message}`);
              },
            });
          },
        },
      ]
    );
  };

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Failed to load events.</Text>
        <TouchableOpacity onPress={() => refetch()} style={styles.retryLink}>
          <Text style={styles.retryLinkText}>Tap to retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Square Sync Issues</Text>
      <Text style={styles.subtitle}>
        {events?.length ?? 0} failed / unmatched event{events?.length !== 1 ? 's' : ''}
      </Text>

      <FlatList
        data={events}
        keyExtractor={(item) => item.event_id}
        renderItem={({ item }) => (
          <EventRow
            item={item}
            onRetry={handleRetry}
            onResolve={handleResolve}
            isRetrying={
              actionEventId === item.event_id && actionType === 'retry' && retryMutation.isPending
            }
            isResolving={
              actionEventId === item.event_id && actionType === 'resolve' && resolveMutation.isPending
            }
          />
        )}
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No failed or unmatched events. 🎉</Text>
          </View>
        }
        contentContainerStyle={events?.length === 0 ? styles.emptyContainer : styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: '#6b7280',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  listContent: {
    padding: 12,
    gap: 12,
  },
  emptyContainer: {
    flexGrow: 1,
  },
  row: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
    gap: 6,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  eventType: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  eventId: {
    fontSize: 12,
    color: '#6b7280',
    fontFamily: 'monospace',
  },
  errorMessage: {
    fontSize: 12,
    color: '#dc2626',
    backgroundColor: '#fef2f2',
    borderRadius: 6,
    padding: 8,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  metaText: {
    fontSize: 12,
    color: '#9ca3af',
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  button: {
    flex: 1,
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
  },
  retryButton: {
    backgroundColor: '#2563eb',
  },
  resolveButton: {
    backgroundColor: '#16a34a',
  },
  buttonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  accessDenied: {
    fontSize: 16,
    color: '#6b7280',
    textAlign: 'center',
  },
  errorText: {
    fontSize: 16,
    color: '#dc2626',
    textAlign: 'center',
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 16,
    color: '#6b7280',
    textAlign: 'center',
  },
  retryLink: {
    marginTop: 8,
  },
  retryLinkText: {
    color: '#2563eb',
    fontSize: 14,
  },
});
