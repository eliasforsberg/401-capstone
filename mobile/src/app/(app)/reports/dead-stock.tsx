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

interface DeadStockRow {
  product_id: string;
  sku: string;
  name: string;
  category: string | null;
  balance: number;
  cost_price: number;
  tied_up_value: number;
  /** How many days since last sale (null = never sold) */
  days_since_last_sale: number | null;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchDeadStock(businessId: string): Promise<DeadStockRow[]> {
  const cutoff60 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // Get all SKUs with positive balance
  const { data: balances, error: bErr } = await supabase
    .from('inventory_balances')
    .select(`
      sku_id,
      quantity,
      products (
        product_id,
        sku,
        name,
        category,
        cost_price,
        is_active
      )
    `)
    .eq('business_id', businessId)
    .gt('quantity', 0);

  if (bErr) throw new Error(bErr.message);

  const eligible = (balances ?? []).filter((r: any) => r.products?.is_active);
  if (eligible.length === 0) return [];

  // Find SKUs that had ANY sale in the last 60 days
  const allSkuIds = eligible.map((r: any) => r.sku_id);

  const { data: recentSales, error: sErr } = await supabase
    .from('inventory_movements')
    .select('sku_id, created_at')
    .eq('business_id', businessId)
    .eq('movement_type', 'sale')
    .in('sku_id', allSkuIds)
    .gte('created_at', cutoff60)
    .order('created_at', { ascending: false });

  if (sErr) throw new Error(sErr.message);

  // Build set of SKUs with recent sales
  const recentSaleSkus = new Set<string>((recentSales ?? []).map((r: any) => r.sku_id));

  // For dead stock items, get the last-ever sale date
  const deadSkuIds = allSkuIds.filter((id: string) => !recentSaleSkus.has(id));
  if (deadSkuIds.length === 0) return [];

  const { data: lastSales, error: lsErr } = await supabase
    .from('inventory_movements')
    .select('sku_id, created_at')
    .eq('business_id', businessId)
    .eq('movement_type', 'sale')
    .in('sku_id', deadSkuIds)
    .order('created_at', { ascending: false });

  if (lsErr) throw new Error(lsErr.message);

  // Build map: sku_id → latest sale date
  const lastSaleMap = new Map<string, string>();
  for (const sale of lastSales ?? []) {
    if (!lastSaleMap.has(sale.sku_id)) {
      lastSaleMap.set(sale.sku_id, sale.created_at);
    }
  }

  const now = Date.now();
  return eligible
    .filter((r: any) => deadSkuIds.includes(r.sku_id))
    .map((r: any) => {
      const p = r.products;
      const balance = Number(r.quantity);
      const costPrice = Number(p.cost_price) ?? 0;
      const lastSaleDate = lastSaleMap.get(r.sku_id);
      const daysSince = lastSaleDate
        ? Math.floor((now - new Date(lastSaleDate).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        product_id: p.product_id,
        sku: p.sku,
        name: p.name,
        category: p.category ?? null,
        balance,
        cost_price: costPrice,
        tied_up_value: balance * costPrice,
        days_since_last_sale: daysSince,
      } as DeadStockRow;
    })
    .sort((a, b) => (b.days_since_last_sale ?? 9999) - (a.days_since_last_sale ?? 9999));
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function DeadStockRow({ item }: { item: DeadStockRow }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.rowSku}>{item.sku}{item.category ? ` · ${item.category}` : ''}</Text>
        <Text style={styles.rowMeta}>
          {item.days_since_last_sale != null
            ? `Last sold ${item.days_since_last_sale} days ago`
            : 'Never sold'}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowBalance}>
          {item.balance.toLocaleString('en-US', { maximumFractionDigits: 0 })} units
        </Text>
        <Text style={styles.rowValue}>
          ${item.tied_up_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
        <Text style={styles.rowValueLabel}>tied up</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function DeadStockScreen() {
  const businessId = useAuthStore((s) => s.businessId);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['report-dead-stock', businessId],
    queryFn: () => fetchDeadStock(businessId!),
    enabled: !!businessId,
    staleTime: 120_000,
  });

  const totalTiedUp = (data ?? []).reduce((sum, r) => sum + r.tied_up_value, 0);

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
          {data?.length ?? 0} SKUs with no sales in 60+ days ·{' '}
          <Text style={styles.summaryHighlight}>
            ${totalTiedUp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} tied up
          </Text>
        </Text>
      </View>

      <FlatList
        data={data}
        keyExtractor={(item) => item.product_id}
        renderItem={({ item }) => <DeadStockRow item={item} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🎉</Text>
            <Text style={styles.emptyText}>No dead stock found — all SKUs sold within 60 days</Text>
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
  summaryHighlight: {
    color: '#FF9500',
    fontWeight: '600',
  },
  listContent: {
    backgroundColor: '#FFFFFF',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
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
    gap: 2,
  },
  rowBalance: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  rowValue: {
    fontSize: 13,
    fontWeight: '500',
    color: '#FF9500',
  },
  rowValueLabel: {
    fontSize: 10,
    color: '#AEAEB2',
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
