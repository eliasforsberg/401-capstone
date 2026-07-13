import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { PurchaseOrderStatus } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface POHistoryRow {
  po_id: string;
  status: PurchaseOrderStatus;
  supplier_name: string;
  source: 'manual' | 'ai_suggested';
  expected_delivery: string | null;
  submitted_at: string | null;
  created_at: string;
  line_count: number;
}

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | PurchaseOrderStatus;

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Draft', value: 'draft' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'Partial', value: 'partially_received' },
  { label: 'Received', value: 'received' },
  { label: 'Cancelled', value: 'cancelled' },
];

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchPOHistory(businessId: string): Promise<POHistoryRow[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select(`
      po_id,
      status,
      source,
      expected_delivery,
      submitted_at,
      created_at,
      suppliers (
        name
      ),
      purchase_order_lines (
        po_line_id
      )
    `)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row: any) => ({
    po_id: row.po_id,
    status: row.status as PurchaseOrderStatus,
    supplier_name: row.suppliers?.name ?? 'Unknown Supplier',
    source: row.source,
    expected_delivery: row.expected_delivery ?? null,
    submitted_at: row.submitted_at ?? null,
    created_at: row.created_at,
    line_count: (row.purchase_order_lines ?? []).length,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  partially_received: 'Partial',
  received: 'Received',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<PurchaseOrderStatus, string> = {
  draft: '#8E8E93',
  submitted: '#007AFF',
  partially_received: '#FF9500',
  received: '#34C759',
  cancelled: '#FF3B30',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function PORow({ item }: { item: POHistoryRow }) {
  const statusColor = STATUS_COLORS[item.status];
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <View style={styles.rowHeaderRow}>
          <Text style={styles.rowSupplier} numberOfLines={1}>
            {item.supplier_name}
          </Text>
          {item.source === 'ai_suggested' && (
            <View style={styles.aiBadge}>
              <Text style={styles.aiBadgeText}>AI</Text>
            </View>
          )}
        </View>
        <Text style={styles.rowMeta}>
          Created {formatDate(item.created_at)}
          {item.submitted_at ? ` · Submitted ${formatDate(item.submitted_at)}` : ''}
        </Text>
        <Text style={styles.rowMeta}>
          {item.line_count} line{item.line_count !== 1 ? 's' : ''}
          {item.expected_delivery ? ` · Expected ${formatDate(item.expected_delivery)}` : ''}
        </Text>
      </View>
      <View style={[styles.statusBadge, { backgroundColor: statusColor + '22' }]}>
        <Text style={[styles.statusBadgeText, { color: statusColor }]}>
          {STATUS_LABELS[item.status]}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function POHistoryScreen() {
  const businessId = useAuthStore((s) => s.businessId);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['report-po-history', businessId],
    queryFn: () => fetchPOHistory(businessId!),
    enabled: !!businessId,
    staleTime: 30_000,
  });

  const filteredData =
    statusFilter === 'all'
      ? (data ?? [])
      : (data ?? []).filter((r) => r.status === statusFilter);

  if (isLoading) {
    return (
      <View style={styles.centeredState}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.centeredState}>
        <Text style={styles.stateText}>Failed to load report.</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Status filter pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterContainer}
      >
        {STATUS_FILTERS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.filterChip, statusFilter === opt.value && styles.filterChipActive]}
            onPress={() => setStatusFilter(opt.value)}
          >
            <Text
              style={[
                styles.filterChipText,
                statusFilter === opt.value && styles.filterChipTextActive,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={styles.countBar}>
        <Text style={styles.countText}>{filteredData.length} purchase orders</Text>
      </View>

      <FlatList
        data={filteredData}
        keyExtractor={(item) => item.po_id}
        renderItem={({ item }) => <PORow item={item} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🗂️</Text>
            <Text style={styles.emptyText}>No purchase orders found</Text>
          </View>
        }
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
    backgroundColor: '#F2F2F7',
  },
  centeredState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  stateText: {
    fontSize: 16,
    color: '#6C6C70',
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#007AFF',
    borderRadius: 8,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  filterScroll: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    maxHeight: 52,
  },
  filterContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    flexDirection: 'row',
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#F2F2F7',
  },
  filterChipActive: {
    backgroundColor: '#007AFF',
  },
  filterChipText: {
    fontSize: 13,
    color: '#3C3C43',
    fontWeight: '500',
  },
  filterChipTextActive: {
    color: '#FFFFFF',
  },
  countBar: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#F2F2F7',
  },
  countText: {
    fontSize: 12,
    color: '#8E8E93',
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  listContent: {
    backgroundColor: '#FFFFFF',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    minHeight: 72,
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  rowHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowSupplier: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1C1E',
    flex: 1,
  },
  aiBadge: {
    backgroundColor: '#E8F0FE',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  aiBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#007AFF',
    letterSpacing: 0.5,
  },
  rowMeta: {
    fontSize: 12,
    color: '#8E8E93',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    flexShrink: 0,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    marginLeft: 16,
  },
  emptyState: {
    alignItems: 'center',
    padding: 40,
    gap: 8,
  },
  emptyIcon: {
    fontSize: 40,
  },
  emptyText: {
    fontSize: 16,
    color: '#6C6C70',
    textAlign: 'center',
  },
});
