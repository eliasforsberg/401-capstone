/**
 * Alerts Feed Screen
 * Displays active and acknowledged alerts with real-time updates.
 * Allows users to acknowledge active alerts.
 *
 * Requirements: 4.3, 4.6, 4.8
 */
import { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert as RNAlert,
} from 'react-native';

import { useAlerts, useAlertsRealtime, useAcknowledgeAlert } from '@/hooks/useAlerts';
import type { Alert as AlertItem } from '@/hooks/useAlerts';
import type { AlertStatus, AlertType } from '@/types';

// ---------------------------------------------------------------------------
// Filter tab definitions
// ---------------------------------------------------------------------------

type FilterTab = 'all' | 'active' | 'acknowledged';

const TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'acknowledged', label: 'Acknowledged' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function alertTypeLabel(type: AlertType): string {
  switch (type) {
    case 'low_stock':
      return 'Low Stock';
    case 'stockout':
      return 'Stockout';
    case 'anomaly':
      return 'Anomaly';
    case 'square_unmatched':
      return 'Unmatched';
    default:
      return type;
  }
}

function alertTypeColor(type: AlertType): string {
  switch (type) {
    case 'stockout':
      return '#dc2626'; // red
    case 'low_stock':
      return '#d97706'; // amber
    case 'anomaly':
      return '#7c3aed'; // purple
    case 'square_unmatched':
      return '#2563eb'; // blue
    default:
      return '#6b7280'; // gray
  }
}

function statusColor(status: AlertStatus): string {
  switch (status) {
    case 'active':
      return '#dc2626';
    case 'acknowledged':
      return '#6b7280';
    case 'resolved':
      return '#16a34a';
    default:
      return '#6b7280';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Alert row component
// ---------------------------------------------------------------------------

interface AlertRowProps {
  item: AlertItem;
  onAcknowledge: (id: string) => void;
  isAcknowledging: boolean;
}

function AlertRow({ item, onAcknowledge, isAcknowledging }: AlertRowProps) {
  const typeColor = alertTypeColor(item.alert_type);

  return (
    <View style={[styles.row, item.status === 'acknowledged' && styles.rowDimmed]}>
      {/* Type badge + status indicator */}
      <View style={styles.rowHeader}>
        <View style={[styles.typeBadge, { backgroundColor: typeColor }]}>
          <Text style={styles.typeBadgeText}>{alertTypeLabel(item.alert_type)}</Text>
        </View>
        <View style={[styles.statusDot, { backgroundColor: statusColor(item.status) }]} />
      </View>

      {/* SKU name */}
      {item.sku_name ? (
        <Text style={styles.skuName}>{item.sku_name}</Text>
      ) : null}

      {/* Message */}
      {item.message ? (
        <Text style={styles.message} numberOfLines={3}>
          {item.message}
        </Text>
      ) : null}

      {/* Timestamp */}
      <Text style={styles.timestamp}>{formatDate(item.created_at)}</Text>

      {/* Acknowledge button — only shown on active alerts */}
      {item.status === 'active' ? (
        <TouchableOpacity
          style={styles.ackButton}
          onPress={() => onAcknowledge(item.alert_id)}
          disabled={isAcknowledging}
          accessibilityLabel={`Acknowledge ${alertTypeLabel(item.alert_type)} alert`}
          accessibilityRole="button"
        >
          {isAcknowledging ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.ackButtonText}>Acknowledge</Text>
          )}
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function AlertsScreen() {
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);

  const { data: alerts, isLoading, error, refetch, isRefetching } = useAlerts();

  // Subscribe to real-time inserts — keeps cache live without polling
  useAlertsRealtime();

  const acknowledgeMutation = useAcknowledgeAlert();

  // Filter alerts based on the active tab
  const filteredAlerts =
    alerts?.filter((a) => {
      if (activeTab === 'all') return true;
      return a.status === activeTab;
    }) ?? [];

  const handleAcknowledge = (alertId: string) => {
    RNAlert.alert(
      'Acknowledge Alert',
      'Mark this alert as acknowledged?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Acknowledge',
          onPress: () => {
            setAcknowledgingId(alertId);
            acknowledgeMutation.mutate(alertId, {
              onSettled: () => setAcknowledgingId(null),
              onError: (err) => {
                RNAlert.alert('Error', `Failed to acknowledge alert: ${err.message}`);
              },
            });
          },
        },
      ]
    );
  };

  // Count active alerts for badge purposes
  const activeCount = alerts?.filter((a) => a.status === 'active').length ?? 0;

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Failed to load alerts.</Text>
        <TouchableOpacity onPress={() => refetch()} style={styles.retryLink}>
          <Text style={styles.retryLinkText}>Tap to retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Alerts</Text>
        {activeCount > 0 ? (
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{activeCount}</Text>
          </View>
        ) : null}
      </View>

      {/* Filter tabs */}
      <View style={styles.tabs}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab.key }}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Alert list */}
      <FlatList
        data={filteredAlerts}
        keyExtractor={(item) => item.alert_id}
        renderItem={({ item }) => (
          <AlertRow
            item={item}
            onAcknowledge={handleAcknowledge}
            isAcknowledging={acknowledgingId === item.alert_id && acknowledgeMutation.isPending}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {activeTab === 'active'
                ? 'No active alerts. All clear!'
                : activeTab === 'acknowledged'
                  ? 'No acknowledged alerts.'
                  : 'No alerts yet.'}
            </Text>
          </View>
        }
        contentContainerStyle={
          filteredAlerts.length === 0 ? styles.emptyFlex : styles.listContent
        }
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} />
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
    backgroundColor: '#f9fafb',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },
  countBadge: {
    backgroundColor: '#dc2626',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  countBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    marginHorizontal: 16,
    marginBottom: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: '#2563eb',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6b7280',
  },
  tabTextActive: {
    color: '#2563eb',
    fontWeight: '600',
  },
  listContent: {
    padding: 12,
    gap: 10,
  },
  emptyFlex: {
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyText: {
    fontSize: 16,
    color: '#6b7280',
    textAlign: 'center',
  },
  row: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
    gap: 6,
  },
  rowDimmed: {
    opacity: 0.7,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  typeBadge: {
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typeBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  skuName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  message: {
    fontSize: 13,
    color: '#4b5563',
    lineHeight: 18,
  },
  timestamp: {
    fontSize: 12,
    color: '#9ca3af',
  },
  ackButton: {
    backgroundColor: '#2563eb',
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    minHeight: 36,
  },
  ackButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 16,
    color: '#dc2626',
    textAlign: 'center',
    marginBottom: 12,
  },
  retryLink: {
    marginTop: 4,
  },
  retryLinkText: {
    color: '#2563eb',
    fontSize: 14,
  },
});
