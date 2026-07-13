import { useQuery } from '@tanstack/react-query';
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

interface SalesVelocityRow {
  product_id: string;
  sku: string;
  name: string;
  category: string | null;
  units_sold_30d: number;
  velocity_per_day: number;
  current_balance: number;
  days_of_stock: number | null;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchSalesVelocity(businessId: string): Promise<SalesVelocityRow[]> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch all sale movements in last 30 days
  const { data: movements, error: mvErr } = await supabase
    .from('inventory_movements')
    .select('sku_id, quantity_delta')
    .eq('business_id', businessId)
    .eq('movement_type', 'sale')
    .gte('created_at', cutoff);

  if (mvErr) throw new Error(mvErr.message);
  if (!movements || movements.length === 0) return [];

  // Aggregate by SKU
  const soldMap = new Map<string, number>();
  for (const mv of movements) {
    const prev = soldMap.get(mv.sku_id) ?? 0;
    soldMap.set(mv.sku_id, prev + Math.abs(Number(mv.quantity_delta)));
  }

  const skuIds = Array.from(soldMap.keys());

  // Fetch product info + balances
  const { data: products, error: pErr } = await supabase
    .from('products')
    .select('product_id, sku, name, category, is_active')
    .eq('business_id', businessId)
    .in('product_id', skuIds);

  if (pErr) throw new Error(pErr.message);

  const { data: balances, error: bErr } = await supabase
    .from('inventory_balances')
    .select('sku_id, quantity')
    .eq('business_id', businessId)
    .in('sku_id', skuIds);

  if (bErr) throw new Error(bErr.message);

  const balanceMap = new Map<string, number>();
  for (const b of balances ?? []) {
    balanceMap.set(b.sku_id, Number(b.quantity));
  }

  return (products ?? [])
    .filter((p: any) => p.is_active)
    .map((p: any) => {
      const unitsSold = soldMap.get(p.product_id) ?? 0;
      const velocityPerDay = unitsSold / 30;
      const currentBalance = balanceMap.get(p.product_id) ?? 0;
      const daysOfStock =
        velocityPerDay > 0 ? Math.floor(currentBalance / velocityPerDay) : null;

      return {
        product_id: p.product_id,
        sku: p.sku,
        name: p.name,
        category: p.category ?? null,
        units_sold_30d: unitsSold,
        velocity_per_day: velocityPerDay,
        current_balance: currentBalance,
        days_of_stock: daysOfStock,
      } as SalesVelocityRow;
    })
    .sort((a, b) => b.velocity_per_day - a.velocity_per_day);
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function VelocityRow({ item, rank }: { item: SalesVelocityRow; rank: number }) {
  const daysColor =
    item.days_of_stock == null
      ? '#8E8E93'
      : item.days_of_stock < 7
      ? '#FF3B30'
      : item.days_of_stock < 14
      ? '#FF9500'
      : '#34C759';

  return (
    <View style={styles.row}>
      <Text style={styles.rowRank}>{rank}</Text>
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.rowSku}>{item.sku}{item.category ? ` · ${item.category}` : ''}</Text>
        <Text style={styles.rowMeta}>
          {item.units_sold_30d.toLocaleString('en-US', { maximumFractionDigits: 0 })} units in 30d
          {' · '}on hand: {item.current_balance.toLocaleString('en-US', { maximumFractionDigits: 0 })}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowVelocity}>
          {item.velocity_per_day.toFixed(1)}
          <Text style={styles.rowVelocityUnit}> u/day</Text>
        </Text>
        {item.days_of_stock != null && (
          <Text style={[styles.rowDays, { color: daysColor }]}>
            ~{item.days_of_stock}d stock
          </Text>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SalesVelocityScreen() {
  const businessId = useAuthStore((s) => s.businessId);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['report-sales-velocity', businessId],
    queryFn: () => fetchSalesVelocity(businessId!),
    enabled: !!businessId,
    staleTime: 60_000,
  });

  const totalSold = (data ?? []).reduce((sum, r) => sum + r.units_sold_30d, 0);

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
      <View style={styles.summaryBar}>
        <Text style={styles.summaryText}>
          {data?.length ?? 0} active SKUs · {totalSold.toLocaleString('en-US', { maximumFractionDigits: 0 })} total units sold (30d)
        </Text>
      </View>

      <View style={styles.columnHeader}>
        <Text style={[styles.columnHeaderText, { width: 28 }]}>#</Text>
        <Text style={[styles.columnHeaderText, { flex: 1 }]}>Product</Text>
        <Text style={[styles.columnHeaderText, { width: 80, textAlign: 'right' }]}>Velocity</Text>
      </View>

      <FlatList
        data={data}
        keyExtractor={(item) => item.product_id}
        renderItem={({ item, index }) => <VelocityRow item={item} rank={index + 1} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>📭</Text>
            <Text style={styles.emptyText}>No sales recorded in the last 30 days</Text>
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
  summaryBar: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  summaryText: {
    fontSize: 13,
    color: '#8E8E93',
  },
  columnHeader: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#F2F2F7',
    gap: 8,
  },
  columnHeaderText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8E8E93',
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
    paddingVertical: 12,
    gap: 8,
    minHeight: 72,
  },
  rowRank: {
    width: 24,
    fontSize: 14,
    fontWeight: '600',
    color: '#C7C7CC',
    textAlign: 'center',
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
    marginBottom: 2,
  },
  rowMeta: {
    fontSize: 11,
    color: '#AEAEB2',
  },
  rowRight: {
    width: 80,
    alignItems: 'flex-end',
    gap: 4,
  },
  rowVelocity: {
    fontSize: 18,
    fontWeight: '700',
    color: '#007AFF',
  },
  rowVelocityUnit: {
    fontSize: 12,
    fontWeight: '400',
    color: '#8E8E93',
  },
  rowDays: {
    fontSize: 11,
    fontWeight: '500',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    marginLeft: 48,
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
