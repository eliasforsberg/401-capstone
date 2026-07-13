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

interface ValuationRow {
  product_id: string;
  sku: string;
  name: string;
  category: string | null;
  balance: number;
  cost_price: number;
  selling_price: number;
  total_cost_value: number;
  total_retail_value: number;
  margin_percent: number;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchInventoryValuation(businessId: string): Promise<ValuationRow[]> {
  const { data, error } = await supabase
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
        selling_price,
        is_active
      )
    `)
    .eq('business_id', businessId)
    .order('quantity', { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? [])
    .filter((row: any) => row.products?.is_active)
    .map((row: any) => {
      const p = row.products;
      const balance = Number(row.quantity) ?? 0;
      const costPrice = Number(p.cost_price) ?? 0;
      const sellingPrice = Number(p.selling_price) ?? 0;
      const totalCost = balance * costPrice;
      const totalRetail = balance * sellingPrice;
      const marginPct =
        sellingPrice > 0
          ? ((sellingPrice - costPrice) / sellingPrice) * 100
          : 0;

      return {
        product_id: p.product_id,
        sku: p.sku,
        name: p.name,
        category: p.category ?? null,
        balance,
        cost_price: costPrice,
        selling_price: sellingPrice,
        total_cost_value: totalCost,
        total_retail_value: totalRetail,
        margin_percent: marginPct,
      };
    });
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function ValuationRow({ item }: { item: ValuationRow }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.rowSku}>{item.sku}{item.category ? ` · ${item.category}` : ''}</Text>
        <Text style={styles.rowPricing}>
          Cost ${item.cost_price.toFixed(2)} · Sell ${item.selling_price.toFixed(2)}
          {' · '}
          <Text style={item.margin_percent >= 0 ? styles.marginPositive : styles.marginNegative}>
            {item.margin_percent.toFixed(1)}% margin
          </Text>
        </Text>
      </View>
      <View style={styles.rowValues}>
        <Text style={styles.rowBalance}>
          {item.balance.toLocaleString('en-US', { maximumFractionDigits: 0 })} u
        </Text>
        <Text style={styles.rowCostValue}>
          ${item.total_cost_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
        <Text style={styles.rowRetailValue}>
          / ${item.total_retail_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function InventoryValuationScreen() {
  const businessId = useAuthStore((s) => s.businessId);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['report-inventory-valuation', businessId],
    queryFn: () => fetchInventoryValuation(businessId!),
    enabled: !!businessId,
    staleTime: 30_000,
  });

  const totalCost = (data ?? []).reduce((sum, r) => sum + r.total_cost_value, 0);
  const totalRetail = (data ?? []).reduce((sum, r) => sum + r.total_retail_value, 0);

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

  const footerComponent = (
    <View style={styles.footer}>
      <View style={styles.footerRow}>
        <Text style={styles.footerLabel}>Total Portfolio Value (at cost)</Text>
        <Text style={styles.footerCost}>
          ${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      </View>
      <View style={styles.footerRow}>
        <Text style={styles.footerLabel}>Total Portfolio Value (at retail)</Text>
        <Text style={styles.footerRetail}>
          ${totalRetail.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Column headers */}
      <View style={styles.columnHeader}>
        <Text style={[styles.columnHeaderText, { flex: 1 }]}>Product</Text>
        <Text style={[styles.columnHeaderText, { width: 100, textAlign: 'right' }]}>Units / Cost / Retail</Text>
      </View>

      <FlatList
        data={data}
        keyExtractor={(item) => item.product_id}
        renderItem={({ item }) => <ValuationRow item={item} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        ListFooterComponent={footerComponent}
        ListEmptyComponent={
          <View style={styles.centeredState}>
            <Text style={styles.stateText}>No inventory data found.</Text>
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
  columnHeader: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#F2F2F7',
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
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 76,
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
  rowPricing: {
    fontSize: 11,
    color: '#AEAEB2',
  },
  marginPositive: {
    color: '#34C759',
  },
  marginNegative: {
    color: '#FF3B30',
  },
  rowValues: {
    width: 100,
    alignItems: 'flex-end',
  },
  rowBalance: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1C1C1E',
    marginBottom: 2,
  },
  rowCostValue: {
    fontSize: 13,
    color: '#007AFF',
    fontWeight: '500',
  },
  rowRetailValue: {
    fontSize: 11,
    color: '#8E8E93',
    marginTop: 1,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    marginLeft: 16,
  },
  footer: {
    backgroundColor: '#F2F2F7',
    padding: 16,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  footerLabel: {
    fontSize: 14,
    color: '#3C3C43',
    flex: 1,
  },
  footerCost: {
    fontSize: 16,
    fontWeight: '700',
    color: '#007AFF',
  },
  footerRetail: {
    fontSize: 16,
    fontWeight: '700',
    color: '#34C759',
  },
});
