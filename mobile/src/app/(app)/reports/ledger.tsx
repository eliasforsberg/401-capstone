import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { exportToCSV } from '@/lib/csvExport';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { MovementType } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LedgerRow {
  movement_id: string;
  product_name: string;
  sku: string;
  movement_type: MovementType;
  source: string;
  quantity_delta: number;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

type TypeFilter = 'all' | MovementType;
type DateRangeFilter = '7d' | '30d' | '90d' | 'all';

const TYPE_FILTERS: { label: string; value: TypeFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Receive', value: 'receive' },
  { label: 'Sale', value: 'sale' },
  { label: 'Return', value: 'return' },
  { label: 'Adjust', value: 'adjustment' },
  { label: 'Count', value: 'count_correction' },
  { label: 'Transfer', value: 'transfer' },
];

const DATE_FILTERS: { label: string; value: DateRangeFilter }[] = [
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: '90d', value: '90d' },
  { label: 'All', value: 'all' },
];

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

function buildCutoff(range: DateRangeFilter): string | null {
  if (range === 'all') return null;
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function fetchLedgerPage({
  businessId,
  typeFilter,
  dateRange,
  page,
}: {
  businessId: string;
  typeFilter: TypeFilter;
  dateRange: DateRangeFilter;
  page: number;
}): Promise<LedgerRow[]> {
  let query = supabase
    .from('inventory_movements')
    .select(`
      movement_id,
      movement_type,
      source,
      quantity_delta,
      reason_code,
      notes,
      created_at,
      products (
        sku,
        name
      )
    `)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

  if (typeFilter !== 'all') {
    query = query.eq('movement_type', typeFilter);
  }

  const cutoff = buildCutoff(dateRange);
  if (cutoff) {
    query = query.gte('created_at', cutoff);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data ?? []).map((row: any) => ({
    movement_id: row.movement_id,
    product_name: row.products?.name ?? 'Unknown',
    sku: row.products?.sku ?? '—',
    movement_type: row.movement_type as MovementType,
    source: row.source,
    quantity_delta: Number(row.quantity_delta),
    reason_code: row.reason_code ?? null,
    notes: row.notes ?? null,
    created_at: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOVEMENT_TYPE_COLORS: Record<MovementType, string> = {
  receive: '#34C759',
  sale: '#FF3B30',
  return: '#007AFF',
  adjustment: '#FF9500',
  count_correction: '#AF52DE',
  transfer: '#5856D6',
};

const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  receive: 'Receive',
  sale: 'Sale',
  return: 'Return',
  adjustment: 'Adjust',
  count_correction: 'Count',
  transfer: 'Transfer',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function LedgerRow({ item }: { item: LedgerRow }) {
  const color = MOVEMENT_TYPE_COLORS[item.movement_type];
  const isPositive = item.quantity_delta > 0;

  return (
    <View style={styles.row}>
      <View style={[styles.typeDot, { backgroundColor: color }]} />
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{item.product_name}</Text>
        <Text style={styles.rowMeta}>
          {item.sku} · {formatDate(item.created_at)}
        </Text>
        {item.reason_code ? (
          <Text style={styles.rowMeta}>Reason: {item.reason_code}</Text>
        ) : null}
        {item.notes ? (
          <Text style={styles.rowNotes} numberOfLines={1}>{item.notes}</Text>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <View style={[styles.typeBadge, { backgroundColor: color + '22' }]}>
          <Text style={[styles.typeBadgeText, { color }]}>
            {MOVEMENT_TYPE_LABELS[item.movement_type]}
          </Text>
        </View>
        <Text style={[styles.rowDelta, isPositive ? styles.deltaPositive : styles.deltaNegative]}>
          {isPositive ? '+' : ''}{item.quantity_delta.toLocaleString('en-US', { maximumFractionDigits: 2 })}
        </Text>
        <Text style={styles.rowSource}>{item.source}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function LedgerScreen() {
  const businessId = useAuthStore((s) => s.businessId);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [dateRange, setDateRange] = useState<DateRangeFilter>('30d');
  const [isExporting, setIsExporting] = useState(false);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, refetch } =
    useInfiniteQuery({
      queryKey: ['report-ledger', businessId, typeFilter, dateRange],
      queryFn: ({ pageParam = 0 }) =>
        fetchLedgerPage({ businessId: businessId!, typeFilter, dateRange, page: pageParam as number }),
      getNextPageParam: (lastPage, allPages) =>
        lastPage.length === PAGE_SIZE ? allPages.length : undefined,
      initialPageParam: 0,
      enabled: !!businessId,
      staleTime: 30_000,
    });

  const rows = (data?.pages ?? []).flat();

  async function handleExportCSV() {
    if (rows.length === 0) {
      Alert.alert('Nothing to export', 'No movements match the current filters.');
      return;
    }
    setIsExporting(true);
    try {
      const headers = ['Product', 'SKU', 'Type', 'Source', 'Qty Delta', 'Reason', 'Notes', 'Date'];
      const csvRows = rows.map((r) => [
        r.product_name,
        r.sku,
        r.movement_type,
        r.source,
        String(r.quantity_delta),
        r.reason_code ?? '',
        r.notes ?? '',
        new Date(r.created_at).toISOString(),
      ]);
      const rangeLabel = dateRange === 'all' ? 'all-time' : dateRange;
      await exportToCSV(headers, csvRows, `ledger-${rangeLabel}-${new Date().toISOString().slice(0, 10)}`);
    } catch {
      Alert.alert('Export Failed', 'Could not export the report. Please try again.');
    } finally {
      setIsExporting(false);
    }
  }

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
        <Text style={styles.stateText}>Failed to load ledger.</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Type filter */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterContainer}
      >
        {TYPE_FILTERS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.filterChip, typeFilter === opt.value && styles.filterChipActive]}
            onPress={() => setTypeFilter(opt.value)}
          >
            <Text
              style={[
                styles.filterChipText,
                typeFilter === opt.value && styles.filterChipTextActive,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Date range filter */}
      <View style={styles.dateFilterRow}>
        {DATE_FILTERS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.dateChip, dateRange === opt.value && styles.dateChipActive]}
            onPress={() => setDateRange(opt.value)}
          >
            <Text
              style={[
                styles.dateChipText,
                dateRange === opt.value && styles.dateChipTextActive,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.dateFilterLabel}>{rows.length}+ movements</Text>
      </View>

      {/* Export button */}
      <TouchableOpacity
        style={[styles.exportButton, isExporting && styles.exportButtonDisabled]}
        onPress={handleExportCSV}
        disabled={isExporting}
        accessibilityLabel="Export ledger as CSV"
        accessibilityRole="button"
      >
        <Text style={styles.exportButtonText}>
          {isExporting ? 'Exporting…' : '⬇ Export CSV'}
        </Text>
      </TouchableOpacity>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.movement_id}
        renderItem={({ item }) => <LedgerRow item={item} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) fetchNextPage();
        }}
        onEndReachedThreshold={0.3}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={styles.loadingMore}>
              <ActivityIndicator size="small" color="#007AFF" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>📋</Text>
            <Text style={styles.emptyText}>No movements found for these filters</Text>
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
  dateFilterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    gap: 6,
  },
  dateChip: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#F2F2F7',
  },
  dateChipActive: {
    backgroundColor: '#E8F0FE',
  },
  dateChipText: {
    fontSize: 12,
    color: '#8E8E93',
    fontWeight: '500',
  },
  dateChipTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  dateFilterLabel: {
    marginLeft: 'auto',
    fontSize: 12,
    color: '#8E8E93',
  },
  listContent: {
    backgroundColor: '#FFFFFF',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    minHeight: 64,
  },
  typeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  rowMain: {
    flex: 1,
    gap: 1,
  },
  rowName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1C1C1E',
  },
  rowMeta: {
    fontSize: 11,
    color: '#8E8E93',
  },
  rowNotes: {
    fontSize: 11,
    color: '#AEAEB2',
    fontStyle: 'italic',
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: 3,
  },
  typeBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  typeBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  rowDelta: {
    fontSize: 15,
    fontWeight: '700',
  },
  deltaPositive: {
    color: '#34C759',
  },
  deltaNegative: {
    color: '#FF3B30',
  },
  rowSource: {
    fontSize: 10,
    color: '#AEAEB2',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    marginLeft: 34,
  },
  loadingMore: {
    paddingVertical: 16,
    alignItems: 'center',
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
  exportButton: {
    marginHorizontal: 16,
    marginVertical: 8,
    paddingVertical: 10,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    alignItems: 'center',
  },
  exportButtonDisabled: {
    backgroundColor: '#AEAEB2',
  },
  exportButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
