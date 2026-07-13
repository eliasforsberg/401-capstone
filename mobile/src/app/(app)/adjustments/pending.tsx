/**
 * Pending Adjustments screen — Owner only.
 *
 * Lists all stock adjustments in `pending_approval` status for the current
 * business. Owners can approve or reject each adjustment inline.
 *
 * Requirements: 5.7, 5.8
 */

import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Modal,
  TextInput,
  RefreshControl,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { SUPABASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingAdjustment {
  adjustment_id: string;
  business_id: string;
  location_id: string;
  sku_id: string;
  quantity_delta: number;
  reason_code: string;
  notes: string | null;
  before_quantity: number;
  after_quantity: number;
  submitted_by: string;
  submitted_at: string;
  status: 'pending_approval';
  created_at: string;
  // Joined fields
  product_name: string | null;
  submitter_display_name: string | null;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchPendingAdjustments(
  businessId: string,
): Promise<PendingAdjustment[]> {
  // Fetch pending adjustments joined with products (name) and user_profiles
  // (display_name of the submitter).
  const { data, error } = await supabase
    .from('inventory_adjustments_pending')
    .select(
      `
      adjustment_id,
      business_id,
      location_id,
      sku_id,
      quantity_delta,
      reason_code,
      notes,
      before_quantity,
      after_quantity,
      submitted_by,
      submitted_at,
      status,
      created_at,
      products ( name ),
      user_profiles!inventory_adjustments_pending_submitted_by_fkey ( display_name )
    `,
    )
    .eq('business_id', businessId)
    .eq('status', 'pending_approval')
    .order('submitted_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row: any) => ({
    adjustment_id: row.adjustment_id,
    business_id: row.business_id,
    location_id: row.location_id,
    sku_id: row.sku_id,
    quantity_delta: row.quantity_delta,
    reason_code: row.reason_code,
    notes: row.notes,
    before_quantity: row.before_quantity,
    after_quantity: row.after_quantity,
    submitted_by: row.submitted_by,
    submitted_at: row.submitted_at,
    status: row.status,
    created_at: row.created_at,
    product_name: row.products?.name ?? null,
    submitter_display_name: row.user_profiles?.display_name ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Edge Function callers
// ---------------------------------------------------------------------------

async function callApproveAdjustment(adjustmentId: string): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) throw new Error('Not authenticated');

  const res = await fetch(`${SUPABASE_URL}/functions/v1/approve-adjustment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ adjustment_id: adjustmentId }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error ?? 'Failed to approve adjustment');
  }
}

async function callRejectAdjustment(
  adjustmentId: string,
  rejectionNote: string,
): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) throw new Error('Not authenticated');

  const res = await fetch(`${SUPABASE_URL}/functions/v1/reject-adjustment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      adjustment_id: adjustmentId,
      rejection_note: rejectionNote.trim() || undefined,
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error ?? 'Failed to reject adjustment');
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Rejection modal
// ---------------------------------------------------------------------------

interface RejectModalProps {
  visible: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
  isLoading: boolean;
}

function RejectModal({ visible, onCancel, onConfirm, isLoading }: RejectModalProps) {
  const [note, setNote] = useState('');

  const handleConfirm = () => {
    onConfirm(note);
    setNote('');
  };

  const handleCancel = () => {
    setNote('');
    onCancel();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Reject Adjustment</Text>
          <Text style={styles.modalSubtitle}>
            Optionally provide a reason for the submitting staff member.
          </Text>

          <TextInput
            style={styles.noteInput}
            placeholder="Rejection reason (optional)"
            value={note}
            onChangeText={setNote}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            editable={!isLoading}
          />

          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalBtn, styles.cancelBtn]}
              onPress={handleCancel}
              disabled={isLoading}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modalBtn, styles.rejectConfirmBtn]}
              onPress={handleConfirm}
              disabled={isLoading}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.confirmBtnText}>Reject</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Adjustment row
// ---------------------------------------------------------------------------

interface AdjustmentRowProps {
  item: PendingAdjustment;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  isActioning: boolean;
}

function AdjustmentRow({ item, onApprove, onReject, isActioning }: AdjustmentRowProps) {
  const deltaPositive = item.quantity_delta > 0;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.productName}>
          {item.product_name ?? item.sku_id}
        </Text>
        <Text
          style={[
            styles.delta,
            deltaPositive ? styles.deltaPositive : styles.deltaNegative,
          ]}
        >
          {formatDelta(item.quantity_delta)}
        </Text>
      </View>

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Reason:</Text>
        <Text style={styles.metaValue}>{item.reason_code}</Text>
      </View>

      {item.notes ? (
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Notes:</Text>
          <Text style={styles.metaValue}>{item.notes}</Text>
        </View>
      ) : null}

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Submitted by:</Text>
        <Text style={styles.metaValue}>
          {item.submitter_display_name ?? item.submitted_by}
        </Text>
      </View>

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Date:</Text>
        <Text style={styles.metaValue}>{formatDate(item.submitted_at)}</Text>
      </View>

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Current balance:</Text>
        <Text style={styles.metaValue}>{item.before_quantity}</Text>
      </View>

      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.approveBtn, isActioning && styles.btnDisabled]}
          onPress={() => onApprove(item.adjustment_id)}
          disabled={isActioning}
          accessibilityLabel={`Approve adjustment for ${item.product_name ?? item.sku_id}`}
          accessibilityRole="button"
        >
          <Text style={styles.approveBtnText}>Approve</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.rejectBtn, isActioning && styles.btnDisabled]}
          onPress={() => onReject(item.adjustment_id)}
          disabled={isActioning}
          accessibilityLabel={`Reject adjustment for ${item.product_name ?? item.sku_id}`}
          accessibilityRole="button"
        >
          <Text style={styles.rejectBtnText}>Reject</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function PendingAdjustmentsScreen() {
  const role = useAuthStore((s) => s.role);
  const businessId = useAuthStore((s) => s.businessId);
  const queryClient = useQueryClient();

  // Reject modal state
  const [rejectTargetId, setRejectTargetId] = useState<string | null>(null);

  // ── Data ────────────────────────────────────────────────────────────────
  const {
    data: adjustments = [],
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: ['pending-adjustments', businessId],
    queryFn: () => fetchPendingAdjustments(businessId!),
    enabled: !!businessId && role === 'owner',
  });

  // ── Mutations ────────────────────────────────────────────────────────────
  const approveMutation = useMutation({
    mutationFn: callApproveAdjustment,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pending-adjustments', businessId] });
      // Also invalidate balance / inventory queries so updated balance appears
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (err: Error) => {
      Alert.alert('Approval failed', err.message);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      callRejectAdjustment(id, note),
    onSuccess: () => {
      setRejectTargetId(null);
      queryClient.invalidateQueries({ queryKey: ['pending-adjustments', businessId] });
    },
    onError: (err: Error) => {
      Alert.alert('Rejection failed', err.message);
    },
  });

  // ── Role guard ───────────────────────────────────────────────────────────
  if (role !== 'owner') {
    return (
      <View style={styles.centeredContainer} accessibilityLiveRegion="polite">
        <Text style={styles.accessDeniedTitle}>Access Denied</Text>
        <Text style={styles.accessDeniedMessage}>
          Only business owners can view and manage pending stock adjustments.
        </Text>
      </View>
    );
  }

  // ── Loading state ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>Loading pending adjustments…</Text>
      </View>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────
  if (isError) {
    return (
      <View style={styles.centeredContainer}>
        <Text style={styles.errorText}>Failed to load pending adjustments.</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => refetch()}>
          <Text style={styles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Approve handler (with confirmation dialog) ───────────────────────────
  const handleApprove = (id: string) => {
    const item = adjustments.find((a) => a.adjustment_id === id);
    const name = item?.product_name ?? item?.sku_id ?? 'this product';
    Alert.alert(
      'Confirm Approval',
      `Approve the stock adjustment of ${item ? formatDelta(item.quantity_delta) : ''} units for ${name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          style: 'default',
          onPress: () => approveMutation.mutate(id),
        },
      ],
    );
  };

  // ── Reject handler (opens modal for optional note) ───────────────────────
  const handleReject = (id: string) => {
    setRejectTargetId(id);
  };

  const handleRejectConfirm = (note: string) => {
    if (!rejectTargetId) return;
    rejectMutation.mutate({ id: rejectTargetId, note });
  };

  const isBusy = approveMutation.isPending || rejectMutation.isPending;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>Pending Adjustments</Text>
      <Text style={styles.screenSubtitle}>
        {adjustments.length === 0
          ? 'No adjustments awaiting approval.'
          : `${adjustments.length} adjustment${adjustments.length === 1 ? '' : 's'} awaiting approval`}
      </Text>

      <FlatList
        data={adjustments}
        keyExtractor={(item) => item.adjustment_id}
        renderItem={({ item }) => (
          <AdjustmentRow
            item={item}
            onApprove={handleApprove}
            onReject={handleReject}
            isActioning={isBusy}
          />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor="#3b82f6"
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>All caught up! ✓</Text>
          </View>
        }
      />

      <RejectModal
        visible={rejectTargetId !== null}
        onCancel={() => setRejectTargetId(null)}
        onConfirm={handleRejectConfirm}
        isLoading={rejectMutation.isPending}
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
    backgroundColor: '#f8fafc',
    paddingTop: 16,
  },
  centeredContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#f8fafc',
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0f172a',
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  screenSubtitle: {
    fontSize: 14,
    color: '#64748b',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  // ── Card ──
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  productName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
    flex: 1,
    marginRight: 8,
  },
  delta: {
    fontSize: 18,
    fontWeight: '700',
  },
  deltaPositive: {
    color: '#16a34a',
  },
  deltaNegative: {
    color: '#dc2626',
  },
  metaRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  metaLabel: {
    fontSize: 13,
    color: '#64748b',
    width: 110,
  },
  metaValue: {
    fontSize: 13,
    color: '#0f172a',
    flex: 1,
  },
  // ── Action buttons ──
  actionRow: {
    flexDirection: 'row',
    marginTop: 14,
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  approveBtn: {
    backgroundColor: '#16a34a',
  },
  approveBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  rejectBtn: {
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#dc2626',
  },
  rejectBtnText: {
    color: '#dc2626',
    fontWeight: '600',
    fontSize: 15,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  // ── Empty / Error / Loading ──
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 48,
  },
  emptyText: {
    fontSize: 16,
    color: '#64748b',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#64748b',
  },
  errorText: {
    fontSize: 15,
    color: '#dc2626',
    textAlign: 'center',
    marginBottom: 16,
  },
  retryBtn: {
    backgroundColor: '#3b82f6',
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  retryBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  // ── Access denied ──
  accessDeniedTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 8,
    textAlign: 'center',
  },
  accessDeniedMessage: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 20,
  },
  // ── Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 20,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 6,
  },
  modalSubtitle: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 14,
    lineHeight: 18,
  },
  noteInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    color: '#0f172a',
    minHeight: 80,
    marginBottom: 16,
    backgroundColor: '#f8fafc',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelBtn: {
    backgroundColor: '#f1f5f9',
  },
  cancelBtnText: {
    color: '#475569',
    fontWeight: '600',
    fontSize: 15,
  },
  rejectConfirmBtn: {
    backgroundColor: '#dc2626',
  },
  confirmBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
});
