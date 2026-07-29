import { useQuery } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import {
  ActivityIndicator,
  ScrollView,
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

interface DashboardKPIs {
  total_stock_units: number;
  total_inventory_value: number;
  low_stock_count: number;
  stockout_count: number;
  sell_through_rate_30d: number;
  shrink_rate_30d: number;
  gross_sales_30d: number;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchDashboardKPIs(businessId: string): Promise<DashboardKPIs> {
  const { data, error } = await supabase.rpc('get_dashboard_kpis', {
    p_business_id: businessId,
  });

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    // Return zero-state when no data exists yet
    return {
      total_stock_units: 0,
      total_inventory_value: 0,
      low_stock_count: 0,
      stockout_count: 0,
      sell_through_rate_30d: 0,
      shrink_rate_30d: 0,
      gross_sales_30d: 0,
    };
  }
  return data[0] as DashboardKPIs;
}

// ---------------------------------------------------------------------------
// KPI card component
// ---------------------------------------------------------------------------

interface KPICardProps {
  title: string;
  value: string;
  subtitle?: string;
  onPress?: () => void;
  accentColor?: string;
  isAlert?: boolean;
}

function KPICard({
  title,
  value,
  subtitle,
  onPress,
  accentColor = '#007AFF',
  isAlert = false,
}: KPICardProps) {
  return (
    <TouchableOpacity
      style={[styles.card, isAlert && styles.cardAlert]}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
    >
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={[styles.cardValue, { color: accentColor }]}>{value}</Text>
      {subtitle ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
      {onPress ? <Text style={styles.cardCta}>View report →</Text> : null}
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatCurrency(value: number): string {
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatUnits(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatPercent(value: number): string {
  return value.toFixed(1) + '%';
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function DashboardScreen() {
  const router = useRouter();
  const businessId = useAuthStore((s) => s.businessId);

  const { data: kpis, isLoading, isError, refetch } = useQuery({
    queryKey: ['dashboard-kpis', businessId],
    queryFn: () => fetchDashboardKPIs(businessId!),
    enabled: !!businessId,
    staleTime: 60_000, // 1 minute
    refetchOnWindowFocus: true,
  });

  // Refetch KPIs whenever the dashboard gains focus so totals stay current
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  if (!businessId) {
    return (
      <View style={styles.centeredState}>
        <Text style={styles.stateText}>No business account found.</Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.centeredState}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.stateText}>Loading dashboard…</Text>
      </View>
    );
  }

  if (isError || !kpis) {
    return (
      <View style={styles.centeredState}>
        <Text style={styles.stateText}>Failed to load KPIs.</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.screenTitle}>Dashboard</Text>
      <Text style={styles.screenSubtitle}>Last updated just now</Text>

      {/* Row 1 — Stock totals */}
      <Text style={styles.sectionLabel}>Inventory</Text>
      <View style={styles.row}>
        <View style={styles.cardHalf}>
          <KPICard
            title="Total Stock"
            value={formatUnits(kpis.total_stock_units)}
            subtitle="units on hand"
            accentColor="#007AFF"
            onPress={() => router.push('/(app)/reports/stock-on-hand' as never)}
          />
        </View>
        <View style={styles.cardHalf}>
          <KPICard
            title="Inventory Value"
            value={formatCurrency(kpis.total_inventory_value)}
            subtitle="at cost (WAC)"
            accentColor="#34C759"
            onPress={() => router.push('/(app)/reports/inventory-valuation' as never)}
          />
        </View>
      </View>

      {/* Row 2 — Alerts */}
      <Text style={styles.sectionLabel}>Alerts</Text>
      <View style={styles.row}>
        <View style={styles.cardHalf}>
          <KPICard
            title="Low Stock SKUs"
            value={String(kpis.low_stock_count)}
            subtitle="at or below reorder point"
            accentColor={kpis.low_stock_count > 0 ? '#FF9500' : '#8E8E93'}
            isAlert={kpis.low_stock_count > 0}
            onPress={() => router.push('/(app)/reports/low-stock' as never)}
          />
        </View>
        <View style={styles.cardHalf}>
          <KPICard
            title="Stockouts"
            value={String(kpis.stockout_count)}
            subtitle="zero-balance SKUs"
            accentColor={kpis.stockout_count > 0 ? '#FF3B30' : '#8E8E93'}
            isAlert={kpis.stockout_count > 0}
            onPress={() => router.push('/(app)/reports/low-stock' as never)}
          />
        </View>
      </View>

      {/* Row 3 — 30-day performance */}
      <Text style={styles.sectionLabel}>Last 30 Days</Text>
      <View style={styles.cardFull}>
        <KPICard
          title="Gross Sales"
          value={formatCurrency(kpis.gross_sales_30d)}
          subtitle="synced from Square + manual entries"
          accentColor="#34C759"
          onPress={() => router.push('/(app)/reports/sales-velocity' as never)}
        />
      </View>
      <View style={styles.row}>
        <View style={styles.cardHalf}>
          <KPICard
            title="Sell-Through"
            value={formatPercent(kpis.sell_through_rate_30d)}
            subtitle="30-day rate"
            accentColor="#007AFF"
            onPress={() => router.push('/(app)/reports/sales-velocity' as never)}
          />
        </View>
        <View style={styles.cardHalf}>
          <KPICard
            title="Shrinkage"
            value={formatPercent(kpis.shrink_rate_30d)}
            subtitle="vs. received units"
            accentColor={kpis.shrink_rate_30d > 5 ? '#FF9500' : '#8E8E93'}
            onPress={() => router.push('/(app)/reports/shrinkage' as never)}
          />
        </View>
      </View>

      {/* Quick links */}
      <Text style={styles.sectionLabel}>Reports</Text>
      <View style={styles.quickLinksContainer}>
        <TouchableOpacity
          style={styles.quickLink}
          onPress={() => router.push('/(app)/reports' as never)}
        >
          <Text style={styles.quickLinkText}>All Reports →</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.quickLink}
          onPress={() => router.push('/(app)/reports/dead-stock' as never)}
        >
          <Text style={styles.quickLinkText}>Dead Stock →</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.quickLink}
          onPress={() => router.push('/(app)/reports/ledger' as never)}
        >
          <Text style={styles.quickLinkText}>Movement Ledger →</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
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
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  centeredState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#F2F2F7',
  },
  stateText: {
    fontSize: 16,
    color: '#6C6C70',
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#007AFF',
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  screenTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1C1C1E',
    marginBottom: 2,
  },
  screenSubtitle: {
    fontSize: 13,
    color: '#8E8E93',
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  cardHalf: {
    flex: 1,
  },
  cardFull: {
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  cardAlert: {
    borderWidth: 1,
    borderColor: '#FFE5CC',
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '500',
    color: '#8E8E93',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  cardValue: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 2,
  },
  cardSubtitle: {
    fontSize: 11,
    color: '#AEAEB2',
    marginBottom: 4,
  },
  cardCta: {
    fontSize: 11,
    color: '#007AFF',
    marginTop: 6,
  },
  quickLinksContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    marginBottom: 12,
  },
  quickLink: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  quickLinkText: {
    fontSize: 15,
    color: '#007AFF',
    fontWeight: '500',
  },
});
