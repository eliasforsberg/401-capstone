/**
 * Recommendations screen — AI-generated inventory suggestions.
 *
 * Features:
 *   - List of pending recommendations with type badge, product name,
 *     confidence badge, rationale, and created_at
 *   - Filter tabs: All / Reorder / Dead Stock / Count / Anomaly
 *   - Tappable rows to expand full rationale
 *   - "Run AI Analysis" button to manually trigger the Edge Function
 *   - Accept / Reject workflow with reason picker for rejections
 *
 * Requirements: 11.1, 11.2, 11.3, 11.6, 11.7, 8.5, 8.8, 8.9
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  useAcceptRecommendation,
  useRecommendations,
  useRejectRecommendation,
  useRunAIAnalysis,
  type Recommendation,
  type RejectionReason,
} from '@/hooks/useRecommendations';
import type { RecommendationType } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type FilterTab = 'all' | RecommendationType;

const FILTER_TABS: { label: string; value: FilterTab }[] = [
  { label: 'All', value: 'all' },
  { label: 'Reorder', value: 'reorder' },
  { label: 'Dead Stock', value: 'dead_stock' },
  { label: 'Count', value: 'count_priority' },
  { label: 'Anomaly', value: 'anomaly' },
];

const TYPE_CONFIG: Record<
  RecommendationType,
  { label: string; color: string; bg: string }
> = {
  reorder: { label: 'Reorder', color: '#007AFF', bg: '#E8F0FE' },
  dead_stock: { label: 'Dead Stock', color: '#FF9500', bg: '#FFF5E6' },
  count_priority: { label: 'Count Priority', color: '#AF52DE', bg: '#F3EAFB' },
  anomaly: { label: 'Anomaly', color: '#FF3B30', bg: '#FFF0EE' },
};

const CONFIDENCE_CONFIG: Record<string, { label: string; color: string }> = {
  heuristic: { label: 'Heuristic', color: '#8E8E93' },
  forecast: { label: 'Forecast', color: '#34C759' },
};

const REJECTION_REASONS: { value: RejectionReason; label: string }[] = [
  { value: 'already_ordered', label: 'Already ordered' },
  { value: 'not_needed', label: 'Not needed' },
  { value: 'wrong_quantity', label: 'Wrong quantity' },
  { value: 'other', label: 'Other' },
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function formatRelativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Reject Modal
// ---------------------------------------------------------------------------

interface RejectModalProps {
  visible: boolean;
  recommendation: Recommendation | null;
  onClose: () => void;
  onConfirm: (reason: RejectionReason) => void;
  isLoading: boolean;
}

function RejectModal({ visible, recommendation, onClose, onConfirm, isLoading }: RejectModalProps) {
  const [selectedReason, setSelectedReason] = useState<RejectionReason | null>(null);

  function handleConfirm() {
    if (!selectedReason) {
      Alert.alert('Select a reason', 'Please select a rejection reason before continuing.');
      return;
    }
    onConfirm(selectedReason);
    setSelectedReason(null);
  }

  function handleClose() {
    setSelectedReason(null);
    onClose();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <View style={modalStyles.backdrop}>
        <View style={modalStyles.sheet}>
          <View style={modalStyles.handle} />
          <Text style={modalStyles.title}>Reject Recommendation</Text>
          {recommendation && (
            <Text style={modalStyles.subtitle} numberOfLines={2}>
              {recommendation.product_name ?? recommendation.sku_id ?? 'Unknown product'}
            </Text>
          )}
          <Text style={modalStyles.sectionLabel}>Reason for rejection</Text>
          {REJECTION_REASONS.map((opt) => (
            <TouchableOpacity
              key={opt.value}
              style={[
                modalStyles.reasonOption,
                selectedReason === opt.value && modalStyles.reasonOptionSelected,
              ]}
              onPress={() => setSelectedReason(opt.value)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selectedReason === opt.value }}
            >
              <View
                style={[
                  modalStyles.radioCircle,
                  selectedReason === opt.value && modalStyles.radioCircleSelected,
                ]}
              />
              <Text style={modalStyles.reasonLabel}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
          <View style={modalStyles.actionRow}>
            <TouchableOpacity style={modalStyles.cancelBtn} onPress={handleClose} disabled={isLoading}>
              <Text style={modalStyles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[modalStyles.confirmBtn, isLoading && modalStyles.confirmBtnDisabled]}
              onPress={handleConfirm}
              disabled={isLoading || !selectedReason}
              accessibilityRole="button"
            >
              {isLoading ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={modalStyles.confirmBtnText}>Reject</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Recommendation Row
// ---------------------------------------------------------------------------

interface RecommendationRowProps {
  item: Recommendation;
  onAccept: (item: Recommendation) => void;
  onReject: (item: Recommendation) => void;
  isAccepting: boolean;
  isRejecting: boolean;
}

function RecommendationRow({
  item,
  onAccept,
  onReject,
  isAccepting,
  isRejecting,
}: RecommendationRowProps) {
  const [expanded, setExpanded] = useState(false);
  const typeConf = TYPE_CONFIG[item.recommendation_type];
  const confidenceConf = CONFIDENCE_CONFIG[item.confidence_level];
  const isLoading = isAccepting || isRejecting;

  return (
    <View style={rowStyles.container}>
      {/* Tap header to toggle rationale */}
      <TouchableOpacity
        style={rowStyles.header}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${typeConf.label} recommendation for ${item.product_name ?? 'unknown product'}`}
        accessibilityHint="Tap to toggle full rationale"
      >
        <View style={rowStyles.headerLeft}>
          {/* Type badge */}
          <View style={[rowStyles.typeBadge, { backgroundColor: typeConf.bg }]}>
            <Text style={[rowStyles.typeBadgeText, { color: typeConf.color }]}>
              {typeConf.label}
            </Text>
          </View>

          {/* Product name */}
          <Text style={rowStyles.productName} numberOfLines={1}>
            {item.product_name ?? item.sku_id ?? 'Unknown product'}
          </Text>
          {item.product_sku ? (
            <Text style={rowStyles.productSku}>
              {item.product_sku}
              {item.product_category ? ` · ${item.product_category}` : ''}
            </Text>
          ) : null}
        </View>

        <View style={rowStyles.headerRight}>
          {/* Confidence badge */}
          <View style={rowStyles.confidenceBadge}>
            <Text style={[rowStyles.confidenceText, { color: confidenceConf.color }]}>
              {confidenceConf.label}
            </Text>
          </View>
          <Text style={rowStyles.createdAt}>{formatRelativeDate(item.created_at)}</Text>
          <Text style={rowStyles.chevron}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>

      {/* Rationale preview (always visible, truncated) */}
      {!expanded && (
        <Text style={rowStyles.rationalePreview} numberOfLines={2}>
          {item.rationale_text}
        </Text>
      )}

      {/* Full rationale (expanded) */}
      {expanded && (
        <View style={rowStyles.expandedBody}>
          <Text style={rowStyles.rationaleText}>{item.rationale_text}</Text>
          {item.suggested_quantity != null && (
            <Text style={rowStyles.suggestedQty}>
              Suggested quantity: {item.suggested_quantity} units
            </Text>
          )}
        </View>
      )}

      {/* Action buttons */}
      <View style={rowStyles.actionRow}>
        <TouchableOpacity
          style={[rowStyles.rejectBtn, isLoading && rowStyles.btnDisabled]}
          onPress={() => onReject(item)}
          disabled={isLoading}
          accessibilityRole="button"
          accessibilityLabel="Reject recommendation"
        >
          {isRejecting ? (
            <ActivityIndicator size="small" color="#FF3B30" />
          ) : (
            <Text style={rowStyles.rejectBtnText}>✕ Reject</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[rowStyles.acceptBtn, isLoading && rowStyles.btnDisabled]}
          onPress={() => onAccept(item)}
          disabled={isLoading}
          accessibilityRole="button"
          accessibilityLabel="Accept recommendation"
        >
          {isAccepting ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={rowStyles.acceptBtnText}>✓ Accept</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function RecommendationsScreen() {
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [rejectTarget, setRejectTarget] = useState<Recommendation | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  const { data: recommendations, isLoading, isError, refetch } = useRecommendations();
  const acceptMutation = useAcceptRecommendation();
  const rejectMutation = useRejectRecommendation();
  const runAnalysisMutation = useRunAIAnalysis();

  const filtered =
    activeTab === 'all'
      ? (recommendations ?? [])
      : (recommendations ?? []).filter((r) => r.recommendation_type === activeTab);

  function handleAccept(item: Recommendation) {
    setAcceptingId(item.recommendation_id);
    acceptMutation.mutate(
      {
        recommendationId: item.recommendation_id,
        skuId: item.sku_id,
        suggestedQuantity: item.suggested_quantity,
        defaultSupplierId: item.default_supplier_id,
        recommendationType: item.recommendation_type,
      },
      {
        onSettled: () => setAcceptingId(null),
        onSuccess: () => {
          Alert.alert(
            'Accepted',
            item.recommendation_type === 'reorder'
              ? 'Recommendation accepted. A draft Purchase Order has been created.'
              : 'Recommendation accepted.',
          );
        },
        onError: (err) => {
          Alert.alert('Error', err.message ?? 'Failed to accept recommendation.');
        },
      },
    );
  }

  function handleRejectPress(item: Recommendation) {
    setRejectTarget(item);
  }

  function handleRejectConfirm(reason: RejectionReason) {
    if (!rejectTarget) return;
    setRejectingId(rejectTarget.recommendation_id);
    rejectMutation.mutate(
      { recommendationId: rejectTarget.recommendation_id, rejectionReason: reason },
      {
        onSettled: () => {
          setRejectingId(null);
          setRejectTarget(null);
        },
        onError: (err) => {
          Alert.alert('Error', err.message ?? 'Failed to reject recommendation.');
        },
      },
    );
  }

  function handleRunAnalysis() {
    Alert.alert(
      'Run AI Analysis',
      'This will analyse your current inventory and generate new recommendations. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Run',
          onPress: () => {
            runAnalysisMutation.mutate(undefined, {
              onSuccess: (result) => {
                Alert.alert(
                  'Analysis complete',
                  `Analysed ${result.processed} products. Check the list for new recommendations.`,
                );
              },
              onError: (err) => {
                Alert.alert('Error', err.message ?? 'Analysis failed. Please try again.');
              },
            });
          },
        },
      ],
    );
  }

  // ---- Loading state ----
  if (isLoading) {
    return (
      <View style={styles.centeredState}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  // ---- Error state ----
  if (isError) {
    return (
      <View style={styles.centeredState}>
        <Text style={styles.stateText}>Failed to load recommendations.</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Filter tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabScroll}
        contentContainerStyle={styles.tabContainer}
      >
        {FILTER_TABS.map((tab) => {
          const count =
            tab.value === 'all'
              ? (recommendations?.length ?? 0)
              : (recommendations ?? []).filter((r) => r.recommendation_type === tab.value).length;
          return (
            <TouchableOpacity
              key={tab.value}
              style={[styles.tab, activeTab === tab.value && styles.tabActive]}
              onPress={() => setActiveTab(tab.value)}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === tab.value }}
            >
              <Text style={[styles.tabText, activeTab === tab.value && styles.tabTextActive]}>
                {tab.label}
              </Text>
              {count > 0 && (
                <View style={[styles.tabBadge, activeTab === tab.value && styles.tabBadgeActive]}>
                  <Text style={[styles.tabBadgeText, activeTab === tab.value && styles.tabBadgeTextActive]}>
                    {count}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Run AI Analysis button */}
      <TouchableOpacity
        style={[styles.runAnalysisButton, runAnalysisMutation.isPending && styles.runAnalysisDisabled]}
        onPress={handleRunAnalysis}
        disabled={runAnalysisMutation.isPending}
        accessibilityRole="button"
        accessibilityLabel="Run AI analysis"
      >
        {runAnalysisMutation.isPending ? (
          <ActivityIndicator size="small" color="#007AFF" />
        ) : (
          <Text style={styles.runAnalysisText}>🤖 Run AI Analysis</Text>
        )}
      </TouchableOpacity>

      {/* List */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.recommendation_id}
        renderItem={({ item }) => (
          <RecommendationRow
            item={item}
            onAccept={handleAccept}
            onReject={handleRejectPress}
            isAccepting={acceptingId === item.recommendation_id && acceptMutation.isPending}
            isRejecting={rejectingId === item.recommendation_id && rejectMutation.isPending}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>✅</Text>
            <Text style={styles.emptyTitle}>All clear</Text>
            <Text style={styles.emptyText}>
              {activeTab === 'all'
                ? 'No pending recommendations. Tap "Run AI Analysis" to check for new insights.'
                : `No pending ${FILTER_TABS.find((t) => t.value === activeTab)?.label} recommendations.`}
            </Text>
          </View>
        }
      />

      {/* Reject modal */}
      <RejectModal
        visible={rejectTarget !== null}
        recommendation={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onConfirm={handleRejectConfirm}
        isLoading={rejectMutation.isPending}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles — screen
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
  tabScroll: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    maxHeight: 52,
  },
  tabContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    flexDirection: 'row',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#F2F2F7',
    gap: 6,
  },
  tabActive: {
    backgroundColor: '#007AFF',
  },
  tabText: {
    fontSize: 13,
    color: '#3C3C43',
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
  tabBadge: {
    backgroundColor: '#E5E5EA',
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    minWidth: 18,
    alignItems: 'center',
  },
  tabBadgeActive: {
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  tabBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#3C3C43',
  },
  tabBadgeTextActive: {
    color: '#FFFFFF',
  },
  runAnalysisButton: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    paddingVertical: 10,
    backgroundColor: '#EEF4FF',
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#007AFF33',
  },
  runAnalysisDisabled: {
    opacity: 0.6,
  },
  runAnalysisText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  listContent: {
    paddingTop: 8,
    paddingBottom: 24,
  },
  separator: {
    height: 8,
  },
  emptyState: {
    alignItems: 'center',
    padding: 48,
    gap: 8,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  emptyText: {
    fontSize: 14,
    color: '#6C6C70',
    textAlign: 'center',
    lineHeight: 20,
  },
});

// ---------------------------------------------------------------------------
// Styles — recommendation row
// ---------------------------------------------------------------------------

const rowStyles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 14,
    gap: 8,
  },
  headerLeft: {
    flex: 1,
    gap: 3,
  },
  headerRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  typeBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 4,
  },
  typeBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  productName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  productSku: {
    fontSize: 12,
    color: '#8E8E93',
  },
  confidenceBadge: {
    backgroundColor: '#F2F2F7',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  confidenceText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  createdAt: {
    fontSize: 11,
    color: '#AEAEB2',
  },
  chevron: {
    fontSize: 10,
    color: '#AEAEB2',
    marginTop: 2,
  },
  rationalePreview: {
    fontSize: 13,
    color: '#6C6C70',
    lineHeight: 18,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  expandedBody: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 6,
  },
  rationaleText: {
    fontSize: 13,
    color: '#3C3C43',
    lineHeight: 19,
  },
  suggestedQty: {
    fontSize: 13,
    fontWeight: '600',
    color: '#007AFF',
  },
  actionRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
  },
  rejectBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: '#E5E5EA',
  },
  rejectBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FF3B30',
  },
  acceptBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#007AFF',
  },
  acceptBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  btnDisabled: {
    opacity: 0.5,
  },
});

// ---------------------------------------------------------------------------
// Styles — reject modal
// ---------------------------------------------------------------------------

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingBottom: 40,
    paddingTop: 16,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: '#E5E5EA',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1C1C1E',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#6C6C70',
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  reasonOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#F2F2F7',
    marginBottom: 8,
    gap: 12,
  },
  reasonOptionSelected: {
    backgroundColor: '#EEF4FF',
    borderWidth: 1,
    borderColor: '#007AFF44',
  },
  radioCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#C7C7CC',
  },
  radioCircleSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#007AFF',
  },
  reasonLabel: {
    fontSize: 15,
    color: '#1C1C1E',
    fontWeight: '500',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#F2F2F7',
    alignItems: 'center',
  },
  cancelBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#3C3C43',
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#FF3B30',
    alignItems: 'center',
  },
  confirmBtnDisabled: {
    opacity: 0.5,
  },
  confirmBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
