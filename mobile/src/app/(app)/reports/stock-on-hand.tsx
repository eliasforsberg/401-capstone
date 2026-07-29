import { useQuery } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { exportToCSV } from '@/lib/csvExport';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StockOnHandRow {
  product_id: string;
  sku: string;
  name: string;
  category: string | null;
  balance: number;
  cost_price: number;
  total_value: number;
  reorder_point: number;
  reorder_quantity: number;
  safety_stock: number;
  is_low_stock: boolean;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchStockOnHand(businessId: string): Promise<StockOnHandRow[]> {
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
        reorder_point,
        reorder_quantity,
        safety_stock,
        is_active
      )
    `)
    .eq('business_id', businessId)
    .order('quantity', { ascending: true });

  if (error) throw new Error(error.message);

  return (data ?? [])
    .filter((row: any) => row.products?.is_active)
    .map((row: any) => {
      const p = row.products;
      const balance = Number(row.quantity) ?? 0;
      const costPrice = Number(p.cost_price) ?? 0;
      return {
        product_id: p.product_id,
        sku: p.sku,
        name: p.name,
        category: p.category ?? null,
        balance,
        cost_price: costPrice,
        total_value: balance * costPrice,
        reorder_point: Number(p.reorder_point) ?? 0,
        reorder_quantity: Number(p.reorder_quantity) ?? 0,
        safety_stock: Number(p.safety_stock) ?? 0,
        is_low_stock: balance <= Number(p.reorder_point),
      };
    });
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function StockRow({ item }: { item: StockOnHandRow }) {
  return (
    <View style={[styles.row, item.is_low_stock && item.balance > 0 && styles.rowLowStock, item.balance <= 0 && styles.rowStockout]}>
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.rowSku}>{item.sku}{item.category ? ` · ${item.category}` : ''}</Text>
      </View>
      <View style={styles.rowStats}>
        <Text style={[styles.rowBalance, item.balance <= 0 && styles.textDanger]}>
          {item.balance.toLocaleString('en-US', { maximumFractionDigits: 0 })} units
        </Text>
        <Text style={styles.rowValue}>
          ${item.total_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
        <Text style={styles.rowReorder}>
          Reorder @ {item.reorder_point}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

export default function StockOnHandScreen() {
  const businessId = useAuthStore((s) => s.businessId);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['report-stock-on-hand', businessId],
    queryFn: () => fetchStockOnHand(businessId!),
    enabled: !!businessId,
    staleTime: 30_000,
  });

  // Refetch when screen gains focus so new products/adjustments appear
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const totalValue = (data ?? []).reduce((sum, r) => sum + r.total_value, 0);
  const totalUnits = (data ?? []).reduce((sum, r) => sum + r.balance, 0);
  const [isExporting, setIsExporting] = useState(false);

  async function handleExportCSV() {
    if (!data || data.length === 0) {
      Alert.alert('Nothing to export', 'The report has no data to export.');
      return;
    }
    setIsExporting(true);
    try {
      const headers = ['SKU', 'Name', 'Category', 'Balance (units)', 'Cost Price', 'Total Value', 'Reorder Point', 'Reorder Qty', 'Safety Stock', 'Status'];
      const rows = data.map((r) => [
        r.sku,
        r.name,
        r.category ?? '',
        String(r.balance),
        r.cost_price.toFixed(2),
        r.total_value.toFixed(2),
        String(r.reorder_point),
        String(r.reorder_quantity),
        String(r.safety_stock),
        r.balance <= 0 ? 'Stockout' : r.is_low_stock ? 'Low Stock' : 'OK',
      ]);
      await exportToCSV(headers, rows, `stock-on-hand-${new Date().toISOString().slice(0, 10)}`);
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
        <Text style={styles.stateText}>Failed to load report.</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Summary header */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryLabel}>SKUs</Text>
          <Text style={styles.summaryValue}>{data?.length ?? 0}</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryLabel}>Total Units</Text>
          <Text style={styles.summaryValue}>{totalUnits.toLocaleString('en-US', { maximumFractionDigits: 0 })}</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryLabel}>Total Value</Text>
          <Text style={styles.summaryValue}>
            ${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Text>
        </View>
      </View>

      {/* Export button */}
      <TouchableOpacity
        style={[styles.exportButton, isExporting && styles.exportButtonDisabled]}
        onPress={handleExportCSV}
        disabled={isExporting}
        accessibilityLabel="Export report as CSV"
        accessibilityRole="button"
      >
        <Text style={styles.exportButtonText}>
          {isExporting ? 'Exporting…' : '⬇ Export CSV'}
        </Text>
      </TouchableOpacity>

      {/* Column headers */}
      <View style={styles.columnHeader}>
        <Text style={[styles.columnHeaderText, { flex: 1 }]}>Product</Text>
        <Text style={[styles.columnHeaderText, { width: 110, textAlign: 'right' }]}>Balance / Value</Text>
      </View>

      <FlatList
        data={data}
        keyExtractor={(item) => item.product_id}
        renderItem={({ item }) => <StockRow item={item} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        initialNumToRender={PAGE_SIZE}
        getItemLayout={(_, index) => ({ length: 72, offset: 72 * index, index })}
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
  summaryBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    gap: 8,
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 11,
    color: '#8E8E93',
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  summaryValue: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1C1E',
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
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 72,
  },
  rowLowStock: {
    backgroundColor: '#FFF9F0',
  },
  rowStockout: {
    backgroundColor: '#FFF5F5',
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
  },
  rowStats: {
    width: 110,
    alignItems: 'flex-end',
  },
  rowBalance: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  rowValue: {
    fontSize: 12,
    color: '#34C759',
    marginTop: 2,
  },
  rowReorder: {
    fontSize: 11,
    color: '#AEAEB2',
    marginTop: 2,
  },
  textDanger: {
    color: '#FF3B30',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    marginLeft: 16,
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
