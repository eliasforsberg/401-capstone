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

interface LowStockRow {
  product_id: string;
  sku: string;
  name: string;
  category: string | null;
  balance: number;
  reorder_point: number;
  safety_stock: number;
  lead_time_days: number;
  /** Units sold per day over the last 30 days (null = no sales data) */
  velocity_per_day: number | null;
  /** Estimated days until stockout at current velocity (null = no velocity) */
  days_to_stockout: number | null;
  is_stockout: boolean;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchLowStock(businessId: string): Promise<LowStockRow[]> {
  // 1. Fetch products at/below their reorder point
  const { data: balances, error: balErr } = await supabase
    .from('inventory_balances')
    .select(`
      sku_id,
      quantity,
      products (
        product_id,
        sku,
        name,
        category,
        reorder_point,
        safety_stock,
        lead_time_days,
        is_active
      )
    `)
    .eq('business_id', businessId);

  if (balErr) throw new Error(balErr.message);

  const lowStockItems = (balances ?? []).filter((row: any) => {
    const p = row.products;
    if (!p?.is_active) return false;
    return Number(row.quantity) <= Number(p.reorder_point);
  });

  if (lowStockItems.length === 0) return [];

  // 2. Fetch 30-day sales velocity for those SKUs
  const skuIds = lowStockItems.map((r: any) => r.sku_id);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: salesData, error: salesErr } = await supabase
    .from('inventory_movements')
    .select('sku_id, quantity_delta')
    .eq('business_id', businessId)
    .eq('movement_type', 'sale')
    .in('sku_id', skuIds)
    .gte('created_at', cutoff);

  if (salesErr) throw new Error(salesErr.message);

  // Aggregate units sold per SKU
  const soldMap = new Map<string, number>();
  for (const mv of salesData ?? []) {
    const prev = soldMap.get(mv.sku_id) ?? 0;
    soldMap.set(mv.sku_id, prev + Math.abs(Number(mv.quantity_delta)));
  }

  return lowStockItems
    .map((row: any) => {
      const p = row.products;
      const balance = Number(row.quantity);
      const soldLast30 = soldMap.get(row.sku_id) ?? 0;
      const velocityPerDay = soldLast30 > 0 ? soldLast30 / 30 : null;
      const daysToStockout =
        velocityPerDay != null && balance > 0
          ? Math.floor(balance / velocityPerDay)
          : null;

      return {
        product_id: p.product_id,
        sku: p.sku,
        name: p.name,
        category: p.category ?? null,
        balance,
        reorder_point: Number(p.reorder_point),
        safety_stock: Number(p.safety_stock) ?? 0,
        lead_time_days: Number(p.lead_time_days) ?? 0,
        velocity_per_day: velocityPerDay,
        days_to_stockout: daysToStockout,
        is_stockout: balance <= 0,
      } as LowStockRow;
    })
    .sort((a, b) => {
      // Stockouts first, then by days to stockout ascending
      if (a.is_stockout !== b.is_stockout) return a.is_stockout ? -1 : 1;
      if (a.days_to_stockout != null && b.days_to_stockout != null) {
        return a.days_to_stockout - b.days_to_stockout;
      }
      return a.balance - b.balance;
    });
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function LowStockRow({ item }: { item: LowStockRow }) {
  const urgencyColor = item.is_stockout
    ? '#FF3B30'
    : item.days_to_stockout != null && item.days_to_stockout <= item.lead_time_days
    ? '#FF9500'
    : '#FFCC00';

  return (
    <View style={[styles.row, { borderLeftColor: urgencyColor, borderLeftWidth: 3 }]}>
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.rowSku}>{item.sku}{item.category ? ` · ${item.category}` : ''}</Text>
        <Text style={styles.rowMeta}>
          {item.velocity_per_day != null
            ? `Velocity: ${item.velocity_per_day.toFixed(1)} u/day`
            : 'No recent sales'}
          {item.lead_time_days > 0 ? ` · Lead time: ${item.lead_time_days}d` : ''}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.rowBalance, item.is_stockout && styles.textDanger]}>
          {item.balance.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          <Text style={styles.textMuted}> / {item.reorder_point}</Text>
        </Text>
        {item.is_stockout ? (
          <View style={[styles.badge, styles.badgeStockout]}>
            <Text style={styles.badgeText}>STOCKOUT</Text>
          </View>
        ) : item.days_to_stockout != null ? (
          <View style={[styles.badge, item.days_to_stockout <= item.lead_time_days ? styles.badgeUrgent : styles.badgeWarning]}>
            <Text style={styles.badgeText}>~{item.days_to_stockout}d left</Text>
          </View>
        ) : (
          <View style={[styles.badge, styles.badgeLow]}>
            <Text style={styles.badgeText}>LOW</Text>
          </View>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function LowStockScreen() {
  const businessId = useAuthStore((s) => s.businessId);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['report-low-stock', businessId],
    queryFn: () => fetchLowStock(businessId!),
    enabled: !!businessId,
    staleTime: 30_000,
  });

  const stockoutCount = (data ?? []).filter((r) => r.is_stockout).length;
  const lowCount = (data ?? []).filter((r) => !r.is_stockout).length;

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
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: '#FF3B30' }]}>{stockoutCount}</Text>
          <Text style={styles.summaryLabel}>Stockouts</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: '#FF9500' }]}>{lowCount}</Text>
          <Text style={styles.summaryLabel}>Low Stock</Text>
        </View>
      </View>

      <FlatList
        data={data}
        keyExtractor={(item) => item.product_id}
        renderItem={({ item }) => <LowStockRow item={item} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>✅</Text>
            <Text style={styles.emptyText}>All SKUs are above reorder point</Text>
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
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    justifyContent: 'center',
    gap: 32,
  },
  summaryItem: {
    alignItems: 'center',
  },
  summaryCount: {
    fontSize: 28,
    fontWeight: '700',
  },
  summaryLabel: {
    fontSize: 12,
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
    paddingLeft: 13,
    minHeight: 72,
  },
  rowMain: {
    flex: 1,
    marginRight: 8,
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
    alignItems: 'flex-end',
    gap: 6,
  },
  rowBalance: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  textDanger: {
    color: '#FF3B30',
  },
  textMuted: {
    fontWeight: '400',
    color: '#8E8E93',
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeStockout: {
    backgroundColor: '#FFDEDE',
  },
  badgeUrgent: {
    backgroundColor: '#FFE5CC',
  },
  badgeWarning: {
    backgroundColor: '#FFF3CC',
  },
  badgeLow: {
    backgroundColor: '#E5E5EA',
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#3C3C43',
    letterSpacing: 0.5,
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
