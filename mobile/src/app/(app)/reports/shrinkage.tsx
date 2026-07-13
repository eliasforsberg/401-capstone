import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const SHRINKAGE_REASON_CODES = ['damage', 'spoilage', 'theft'] as const;
type ShrinkageReasonCode = typeof SHRINKAGE_REASON_CODES[number];

interface ShrinkageRow {
  movement_id: string;
  sku: string;
  product_name: string;
  reason_code: ShrinkageReasonCode;
  quantity_delta: number;
  notes: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Date range options
// ---------------------------------------------------------------------------

type DateRange = '7d' | '30d' | '90d';

const DATE_RANGE_OPTIONS: { label: string; value: DateRange }[] = [
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
  { label: '90 days', value: '90d' },
];

function getCutoff(range: DateRange): string {
  const ms = { '7d': 7, '30d': 30, '90d': 90 }[range] * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchShrinkage(
  businessId: string,
  dateRange: DateRange
): Promise<ShrinkageRow[]> {
  const cutoff = getCutoff(dateRange);

  const { data, error } = await supabase
    .from('inventory_movements')
    .select(`
      movement_id,
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
    .eq('movement_type', 'adjustment')
    .in('reason_code', SHRINKAGE_REASON_CODES)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row: any) => ({
    movement_id: row.movement_id,
    sku: row.products?.sku ?? '—',
    product_name: row.products?.name ?? 'Unknown Product',
    reason_code: row.reason_code as ShrinkageReasonCode,
    quantity_delta: Number(row.quantity_delta),
    notes: row.notes ?? null,
    created_at: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REASON_LABELS: Record<ShrinkageReasonCode, string> = {
  damage: 'Damage',
  spoilage: 'Spoilage',
  theft: 'Theft',
};

const REASON_COLORS: Record<ShrinkageReasonCode, string> = {
  damage: '#FF9500',
  spoilage: '#FFCC00',
  theft: '#FF3B30',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function ShrinkageRow({ item }: { item: ShrinkageRow }) {
  const color = REASON_COLORS[item.reason_code];
  return (
    <View style={styles.row}>
      <View style={[styles.reasonDot, { backgroundColor: color }]} />
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{item.product_name}</Text>
        <Text style={styles.rowSku}>{item.sku} · {formatDate(item.created_at)}</Text>
        {item.notes ? <Text style={styles.rowNotes} numberOfLines={1}>{item.notes}</Text> : null}
      </View>
      <View style={styles.rowRight}>
        <View style={[styles.reasonBadge, { backgroundColor: color + '22' }]}>
          <Text style={[styles.reasonBadgeText, { color }]}>
            {REASON_LABELS[item.reason_code]}
          </Text>
        </View>
        <Text style={styles.rowDelta}>
          {Math.abs(item.quantity_delta).toLocaleString('en-US', { maximumFractionDigits: 2 })} units
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ShrinkageScreen() {
  const businessId = useAuthStore((s) => s.businessId);
  const [dateRange, setDateRange] = useState<DateRange>('30d');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['report-shrinkage', businessId, dateRange],
    queryFn: () => fetchShrinkage(businessId!, dateRange),
    enabled: !!businessId,
    staleTime: 60_000,
  });

  const totalShrinkUnits = (data ?? []).reduce(
    (sum, r) => sum + Math.abs(r.quantity_delta),
    0
  );
  const byReason = {
    damage: (data ?? []).filter((r) => r.reason_code === 'damage').length,
    spoilage: (data ?? []).filter((r) => r.reason_code === 'spoilage').length,
    theft: (data ?? []).filter((r) => r.reason_code === 'theft').length,
  };

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
      {/* Date range filter */}
      <View style={styles.filterBar}>
        {DATE_RANGE_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.filterChip, dateRange === opt.value && styles.filterChipActive]}
            onPress={() => setDateRange(opt.value)}
          >
            <Text
              style={[styles.filterChipText, dateRange === opt.value && styles.filterChipTextActive]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Summary */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryCount}>{totalShrinkUnits.toFixed(0)}</Text>
          <Text style={styles.summaryLabel}>Total units lost</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: '#FF9500' }]}>{byReason.damage}</Text>
          <Text style={styles.summaryLabel}>Damage</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: '#FFCC00' }]}>{byReason.spoilage}</Text>
          <Text style={styles.summaryLabel}>Spoilage</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: '#FF3B30' }]}>{byReason.theft}</Text>
          <Text style={styles.summaryLabel}>Theft</Text>
        </View>
      </View>

      <FlatList
        data={data}
        keyExtractor={(item) => item.movement_id}
        renderItem={({ item }) => <ShrinkageRow item={item} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>✅</Text>
            <Text style={styles.emptyText}>No shrinkage recorded in this period</Text>
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
  filterBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
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
  summaryBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    justifyContent: 'space-around',
  },
  summaryItem: {
    alignItems: 'center',
    flex: 1,
  },
  summaryCount: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1C1C1E',
  },
  summaryLabel: {
    fontSize: 11,
    color: '#8E8E93',
    marginTop: 2,
  },
  summaryDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    alignSelf: 'stretch',
  },
  listContent: {
    backgroundColor: '#FFFFFF',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    minHeight: 64,
  },
  reasonDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  rowMain: {
    flex: 1,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1C1C1E',
    marginBottom: 2,
  },
  rowSku: {
    fontSize: 12,
    color: '#8E8E93',
  },
  rowNotes: {
    fontSize: 11,
    color: '#AEAEB2',
    marginTop: 2,
    fontStyle: 'italic',
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  reasonBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  reasonBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  rowDelta: {
    fontSize: 13,
    fontWeight: '600',
    color: '#3C3C43',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    marginLeft: 36,
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
