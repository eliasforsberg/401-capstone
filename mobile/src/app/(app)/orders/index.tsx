/**
 * Purchase Orders list screen.
 *
 * Shows all POs for the current business with:
 *   - Status filter tabs (All / Draft / Submitted / In Progress / Received / Cancelled)
 *   - Badge count next to each tab label
 *   - Each row: supplier name, status badge, created date, line count
 *   - Tap → PO detail screen
 *   - "New PO" button → create PO form placeholder
 *
 * Requirements: 8.2, 8.3
 */

import { useMemo, useState } from 'react';
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

import {
  usePurchaseOrders,
  type PurchaseOrder,
} from '@/hooks/usePurchaseOrders';
import type { PurchaseOrderStatus } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_TABS: Array<{ key: PurchaseOrderStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'partially_received', label: 'In Progress' },
  { key: 'received', label: 'Received' },
  { key: 'cancelled', label: 'Cancelled' },
];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft: { bg: '#F3F4F6', text: '#374151' },
  submitted: { bg: '#DBEAFE', text: '#1D4ED8' },
  partially_received: { bg: '#FEF3C7', text: '#92400E' },
  received: { bg: '#D1FAE5', text: '#065F46' },
  cancelled: { bg: '#FEE2E2', text: '#991B1B' },
};

const STATUS_DISPLAY: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  partially_received: 'In Progress',
  received: 'Received',
  cancelled: 'Cancelled',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const colors = STATUS_COLORS[status] ?? { bg: '#F3F4F6', text: '#374151' };
  return (
    <View style={[styles.badge, { backgroundColor: colors.bg }]}>
      <Text style={[styles.badgeText, { color: colors.text }]}>
        {STATUS_DISPLAY[status] ?? status}
      </Text>
    </View>
  );
}

function PORow({
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
        <Text style={styles.metaText}>Created {formatDate(item.created_at)}</Text>
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

export default function OrdersIndexScreen() {
  const [activeTab, setActiveTab] = useState<PurchaseOrderStatus | 'all'>('all');

  // Fetch all POs; filter client-side so badge counts are always available
  const { data: allPOs = [], isLoading, isRefetching, refetch } = usePurchaseOrders();

  // Badge counts per status
  const counts = useMemo(() => {
    const tally: Record<string, number> = { all: allPOs.length };
    for (const po of allPOs) {
      tally[po.status] = (tally[po.status] ?? 0) + 1;
    }
    return tally;
  }, [allPOs]);

  // Filtered list for the selected tab
  const filteredPOs = useMemo(() => {
    if (activeTab === 'all') return allPOs;
    return allPOs.filter((po) => po.status === activeTab);
  }, [allPOs, activeTab]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* ---- Header ---- */}
      <View style={styles.header}>
        <Text style={styles.title}>Purchase Orders</Text>
        <TouchableOpacity
          style={styles.newButton}
          onPress={() => router.push('/(app)/orders/new')}
          activeOpacity={0.8}
        >
          <Text style={styles.newButtonText}>+ New PO</Text>
        </TouchableOpacity>
      </View>

      {/* ---- Status filter tabs ---- */}
      <View style={styles.tabsWrapper}>
        <FlatList
          horizontal
          data={STATUS_TABS}
          keyExtractor={(t) => t.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsContent}
          renderItem={({ item: tab }) => {
            const isActive = activeTab === tab.key;
            const count = counts[tab.key] ?? 0;
            return (
              <TouchableOpacity
                style={[styles.tab, isActive && styles.tabActive]}
                onPress={() => setActiveTab(tab.key)}
                activeOpacity={0.7}
              >
                <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
                {count > 0 && (
                  <View
                    style={[
                      styles.tabBadge,
                      isActive ? styles.tabBadgeActive : styles.tabBadgeInactive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.tabBadgeText,
                        isActive
                          ? styles.tabBadgeTextActive
                          : styles.tabBadgeTextInactive,
                      ]}
                    >
                      {count}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* ---- PO list ---- */}
      <FlatList
        data={filteredPOs}
        keyExtractor={(item) => item.po_id}
        contentContainerStyle={
          filteredPOs.length === 0 ? styles.emptyContainer : styles.listContent
        }
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor="#6366F1"
          />
        }
        renderItem={({ item }) => (
          <PORow
            item={item}
            onPress={() => router.push(`/(app)/orders/${item.po_id}`)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No purchase orders</Text>
            <Text style={styles.emptySubtitle}>
              {activeTab === 'all'
                ? "Tap '+ New PO' to create your first purchase order."
                : `No ${STATUS_DISPLAY[activeTab] ?? activeTab} orders found.`}
            </Text>
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
    backgroundColor: '#F9FAFB',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F9FAFB',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  newButton: {
    backgroundColor: '#6366F1',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  newButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },

  // Tabs
  tabsWrapper: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  tabsContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
    gap: 5,
  },
  tabActive: {
    backgroundColor: '#EEF2FF',
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B7280',
  },
  tabLabelActive: {
    color: '#4F46E5',
    fontWeight: '600',
  },
  tabBadge: {
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  tabBadgeActive: {
    backgroundColor: '#4F46E5',
  },
  tabBadgeInactive: {
    backgroundColor: '#D1D5DB',
  },
  tabBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  tabBadgeTextActive: {
    color: '#FFFFFF',
  },
  tabBadgeTextInactive: {
    color: '#374151',
  },

  // List
  listContent: {
    padding: 12,
    gap: 10,
    paddingBottom: 40,
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

  // PO row card
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
});
