import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { PurchaseOrderStatus } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SupplierInfo {
  name: string;
}

interface PurchaseOrder {
  po_id: string;
  status: PurchaseOrderStatus;
  expected_delivery: string | null;
  created_at: string;
  suppliers: SupplierInfo | null;
  line_count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<string, string> = {
  submitted: 'Submitted',
  partially_received: 'Partial',
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  submitted: { bg: '#DBEAFE', text: '#1D4ED8' },
  partially_received: { bg: '#FEF3C7', text: '#92400E' },
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? { bg: '#F3F4F6', text: '#374151' };
  return (
    <View style={[styles.badge, { backgroundColor: colors.bg }]}>
      <Text style={[styles.badgeText, { color: colors.text }]}>
        {STATUS_LABELS[status] ?? status}
      </Text>
    </View>
  );
}

function POListItem({
  item,
  onPress,
}: {
  item: PurchaseOrder;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.cardHeader}>
        <Text style={styles.supplierName} numberOfLines={1}>
          {item.suppliers?.name ?? 'Unknown Supplier'}
        </Text>
        <StatusBadge status={item.status} />
      </View>
      <View style={styles.cardMeta}>
        <Text style={styles.metaText}>
          Expected: {formatDate(item.expected_delivery)}
        </Text>
        <Text style={styles.metaText}>
          {item.line_count} {item.line_count === 1 ? 'line' : 'lines'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ReceiveIndexScreen() {
  const businessId = useAuthStore((s) => s.businessId);

  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOrders = useCallback(async () => {
    if (!businessId) return;
    setError(null);

    const { data, error: fetchError } = await supabase
      .from('purchase_orders')
      .select(
        `
        po_id,
        status,
        expected_delivery,
        created_at,
        suppliers ( name ),
        purchase_order_lines ( po_line_id )
        `
      )
      .eq('business_id', businessId)
      .in('status', ['submitted', 'partially_received'])
      .order('created_at', { ascending: false });

    if (fetchError) {
      setError('Failed to load purchase orders. Please try again.');
      return;
    }

    // Map raw rows — count lines from nested array
    const mapped: PurchaseOrder[] = (data ?? []).map((row: any) => ({
      po_id: row.po_id,
      status: row.status,
      expected_delivery: row.expected_delivery,
      created_at: row.created_at,
      suppliers: row.suppliers,
      line_count: Array.isArray(row.purchase_order_lines)
        ? row.purchase_order_lines.length
        : 0,
    }));

    setOrders(mapped);
  }, [businessId]);

  useEffect(() => {
    setLoading(true);
    fetchOrders().finally(() => setLoading(false));
  }, [fetchOrders]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchOrders();
    setRefreshing(false);
  }, [fetchOrders]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Receive Stock</Text>
      </View>

      {/* Error state */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* PO list */}
      <FlatList
        data={orders}
        keyExtractor={(item) => item.po_id}
        renderItem={({ item }) => (
          <POListItem
            item={item}
            onPress={() => router.push(`/(app)/receive/${item.po_id}`)}
          />
        )}
        contentContainerStyle={
          orders.length === 0 ? styles.emptyContainer : styles.listContent
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No open purchase orders</Text>
            <Text style={styles.emptySubtitle}>
              Submitted and partially-received POs will appear here.
            </Text>
          </View>
        }
      />

      {/* Ad Hoc Receive button */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.adhocButton}
          onPress={() => router.push('/(app)/receive/adhoc')}
          activeOpacity={0.8}
        >
          <Text style={styles.adhocButtonText}>Ad Hoc Receive</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F9FAFB',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
  },
  errorBanner: {
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorText: {
    color: '#991B1B',
    fontSize: 14,
  },
  listContent: {
    padding: 12,
    gap: 10,
  },
  emptyContainer: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 80,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  supplierName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    flex: 1,
    marginRight: 8,
  },
  badge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  cardMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  metaText: {
    fontSize: 13,
    color: '#6B7280',
  },
  footer: {
    padding: 16,
    paddingBottom: 32,
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E7EB',
  },
  adhocButton: {
    backgroundColor: '#6366F1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  adhocButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
