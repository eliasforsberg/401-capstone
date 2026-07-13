import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { PurchaseOrderStatus } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Supplier {
  name: string;
}

interface PurchaseOrderHeader {
  po_id: string;
  status: PurchaseOrderStatus;
  expected_delivery: string | null;
  suppliers: Supplier | null;
}

interface POLine {
  po_line_id: string;
  sku_id: string;
  ordered_quantity: number;
  received_quantity: number;
  unit_cost: number | null;
  status: string;
  // Joined from products table
  product_name: string;
}

/** State for the inline receive form attached to a single PO line. */
interface ReceiveFormState {
  receivedQty: string;
  damagedQty: string;
  unitCost: string;
}

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

function generateIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function checkConnectivity(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const response = await fetch('https://www.google.com', {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const palette: Record<string, { bg: string; text: string }> = {
    submitted: { bg: '#DBEAFE', text: '#1D4ED8' },
    partially_received: { bg: '#FEF3C7', text: '#92400E' },
    received: { bg: '#D1FAE5', text: '#065F46' },
    pending: { bg: '#F3F4F6', text: '#374151' },
  };
  const colors = palette[status] ?? { bg: '#F3F4F6', text: '#374151' };
  const labels: Record<string, string> = {
    submitted: 'Submitted',
    partially_received: 'Partial',
    received: 'Received',
    pending: 'Pending',
  };
  return (
    <View style={[linestyles.badge, { backgroundColor: colors.bg }]}>
      <Text style={[linestyles.badgeText, { color: colors.text }]}>
        {labels[status] ?? status}
      </Text>
    </View>
  );
}

function POLineCard({
  line,
  expanded,
  form,
  submitting,
  pendingSync,
  onToggle,
  onFormChange,
  onConfirm,
}: {
  line: POLine;
  expanded: boolean;
  form: ReceiveFormState;
  submitting: boolean;
  pendingSync: boolean;
  onToggle: () => void;
  onFormChange: (field: keyof ReceiveFormState, value: string) => void;
  onConfirm: () => void;
}) {
  const remaining = Math.max(
    0,
    line.ordered_quantity - line.received_quantity
  );
  const isFullyReceived = line.status === 'received';

  return (
    <View style={linestyles.card}>
      {/* Line summary row */}
      <View style={linestyles.summaryRow}>
        <View style={linestyles.productInfo}>
          <Text style={linestyles.productName} numberOfLines={2}>
            {line.product_name}
          </Text>
          <View style={linestyles.qtyRow}>
            <Text style={linestyles.qtyLabel}>Ordered: </Text>
            <Text style={linestyles.qtyValue}>{line.ordered_quantity}</Text>
            <Text style={linestyles.qtyDivider}> · </Text>
            <Text style={linestyles.qtyLabel}>Received: </Text>
            <Text style={linestyles.qtyValue}>{line.received_quantity}</Text>
            <Text style={linestyles.qtyDivider}> · </Text>
            <Text style={linestyles.qtyLabel}>Remaining: </Text>
            <Text
              style={[
                linestyles.qtyValue,
                remaining > 0 ? linestyles.qtyRemaining : linestyles.qtyDone,
              ]}
            >
              {remaining}
            </Text>
          </View>
        </View>
        <View style={linestyles.rightCol}>
          <StatusBadge status={line.status} />
          {!isFullyReceived && (
            <TouchableOpacity
              style={linestyles.receiveBtn}
              onPress={onToggle}
              activeOpacity={0.7}
            >
              <Text style={linestyles.receiveBtnText}>
                {expanded ? 'Cancel' : 'Receive'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Inline receive form */}
      {expanded && !isFullyReceived && (
        <View style={linestyles.form}>
          <View style={linestyles.divider} />

          {/* Received qty */}
          <View style={linestyles.fieldRow}>
            <Text style={linestyles.fieldLabel}>Received qty *</Text>
            <TextInput
              style={linestyles.input}
              value={form.receivedQty}
              onChangeText={(v) => onFormChange('receivedQty', v)}
              keyboardType="decimal-pad"
              placeholder={String(remaining)}
              placeholderTextColor="#9CA3AF"
            />
          </View>

          {/* Damaged qty */}
          <View style={linestyles.fieldRow}>
            <Text style={linestyles.fieldLabel}>Damaged qty</Text>
            <TextInput
              style={linestyles.input}
              value={form.damagedQty}
              onChangeText={(v) => onFormChange('damagedQty', v)}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor="#9CA3AF"
            />
          </View>

          {/* Unit cost */}
          <View style={linestyles.fieldRow}>
            <Text style={linestyles.fieldLabel}>Unit cost ($)</Text>
            <TextInput
              style={linestyles.input}
              value={form.unitCost}
              onChangeText={(v) => onFormChange('unitCost', v)}
              keyboardType="decimal-pad"
              placeholder={
                line.unit_cost != null ? String(line.unit_cost) : '0.00'
              }
              placeholderTextColor="#9CA3AF"
            />
          </View>

          {/* Pending sync indicator */}
          {pendingSync && (
            <View style={linestyles.pendingBanner}>
              <Text style={linestyles.pendingText}>⏳ Pending sync</Text>
            </View>
          )}

          {/* Confirm button */}
          <TouchableOpacity
            style={[
              linestyles.confirmBtn,
              submitting && linestyles.confirmBtnDisabled,
            ]}
            onPress={onConfirm}
            disabled={submitting}
            activeOpacity={0.8}
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={linestyles.confirmBtnText}>Confirm Receive</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ReceivePOScreen() {
  const { poId } = useLocalSearchParams<{ poId: string }>();
  const businessId = useAuthStore((s) => s.businessId);

  const [header, setHeader] = useState<PurchaseOrderHeader | null>(null);
  const [lines, setLines] = useState<POLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Map: po_line_id → whether its receive form is expanded
  const [expandedLineId, setExpandedLineId] = useState<string | null>(null);

  // Map: po_line_id → form state
  const [forms, setForms] = useState<Record<string, ReceiveFormState>>({});

  // Map: po_line_id → submitting flag
  const [submittingIds, setSubmittingIds] = useState<Set<string>>(new Set());

  // Map: po_line_id → pending sync flag (offline)
  const [pendingSyncIds, setPendingSyncIds] = useState<Set<string>>(new Set());

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchPO = useCallback(async () => {
    if (!poId || !businessId) return;
    setError(null);

    // Fetch PO header
    const { data: poData, error: poError } = await supabase
      .from('purchase_orders')
      .select('po_id, status, expected_delivery, suppliers ( name )')
      .eq('po_id', poId)
      .eq('business_id', businessId)
      .single();

    if (poError || !poData) {
      setError('Purchase order not found.');
      return;
    }
    setHeader(poData as unknown as PurchaseOrderHeader);

    // Fetch PO lines joined to products for product name
    const { data: linesData, error: linesError } = await supabase
      .from('purchase_order_lines')
      .select(
        `
        po_line_id,
        sku_id,
        ordered_quantity,
        received_quantity,
        unit_cost,
        status,
        products ( name )
        `
      )
      .eq('po_id', poId)
      .eq('business_id', businessId)
      .order('created_at', { ascending: true });

    if (linesError) {
      setError('Failed to load PO lines.');
      return;
    }

    const mapped: POLine[] = (linesData ?? []).map((row: any) => ({
      po_line_id: row.po_line_id,
      sku_id: row.sku_id,
      ordered_quantity: Number(row.ordered_quantity),
      received_quantity: Number(row.received_quantity),
      unit_cost: row.unit_cost != null ? Number(row.unit_cost) : null,
      status: row.status,
      product_name: row.products?.name ?? 'Unknown Product',
    }));

    setLines(mapped);

    // Initialise form state for each line pre-filled with remaining qty
    const initialForms: Record<string, ReceiveFormState> = {};
    for (const line of mapped) {
      const remaining = Math.max(
        0,
        line.ordered_quantity - line.received_quantity
      );
      initialForms[line.po_line_id] = {
        receivedQty: remaining > 0 ? String(remaining) : '',
        damagedQty: '',
        unitCost: line.unit_cost != null ? String(line.unit_cost) : '',
      };
    }
    setForms(initialForms);
  }, [poId, businessId]);

  useEffect(() => {
    setLoading(true);
    fetchPO().finally(() => setLoading(false));
  }, [fetchPO]);

  // ---------------------------------------------------------------------------
  // Form interactions
  // ---------------------------------------------------------------------------

  function toggleLine(lineId: string) {
    setExpandedLineId((prev) => (prev === lineId ? null : lineId));
  }

  function handleFormChange(
    lineId: string,
    field: keyof ReceiveFormState,
    value: string
  ) {
    setForms((prev) => ({
      ...prev,
      [lineId]: { ...prev[lineId], [field]: value },
    }));
  }

  // ---------------------------------------------------------------------------
  // Submit receive
  // ---------------------------------------------------------------------------

  const handleConfirm = useCallback(
    async (line: POLine) => {
      const form = forms[line.po_line_id];
      if (!form) return;

      const receivedQty = parseFloat(form.receivedQty);
      const damagedQty = parseFloat(form.damagedQty || '0') || 0;
      const unitCost =
        form.unitCost.trim() !== '' ? parseFloat(form.unitCost) : undefined;

      // Validation
      if (isNaN(receivedQty) || receivedQty <= 0) {
        Alert.alert('Invalid quantity', 'Received quantity must be greater than 0.');
        return;
      }
      if (damagedQty < 0) {
        Alert.alert('Invalid quantity', 'Damaged quantity cannot be negative.');
        return;
      }
      if (damagedQty > receivedQty) {
        Alert.alert(
          'Invalid quantity',
          'Damaged quantity cannot exceed received quantity.'
        );
        return;
      }

      // Check connectivity
      const isOnline = await checkConnectivity();
      const idempotencyKey = generateIdempotencyKey();

      if (!isOnline) {
        // Mark as pending sync — offline queue handled by task 15.2
        setPendingSyncIds((prev) => new Set(prev).add(line.po_line_id));
        Alert.alert(
          'Offline',
          'No internet connection. This receive will sync automatically when you reconnect.'
        );
        return;
      }

      // Mark as submitting
      setSubmittingIds((prev) => new Set(prev).add(line.po_line_id));

      try {
        const { error: fnError } = await supabase.functions.invoke(
          'receive-stock',
          {
            body: {
              po_id: poId,
              lines: [
                {
                  sku_id: line.sku_id,
                  received_qty: receivedQty,
                  damaged_qty: damagedQty,
                  unit_cost: unitCost ?? null,
                },
              ],
              idempotency_key: idempotencyKey,
            },
          }
        );

        if (fnError) {
          throw new Error(fnError.message ?? 'Receive failed');
        }

        // Collapse form and refresh lines
        setExpandedLineId(null);
        await fetchPO();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'An unexpected error occurred.';
        Alert.alert('Receive failed', message);
      } finally {
        setSubmittingIds((prev) => {
          const next = new Set(prev);
          next.delete(line.po_line_id);
          return next;
        });
      }
    },
    [forms, poId, fetchPO]
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  if (error || !header) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? 'Something went wrong.'}</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Back button + header info */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backTouchable}>
          <Text style={styles.backArrow}>‹</Text>
          <Text style={styles.backLabel}>Back</Text>
        </TouchableOpacity>
        <View style={styles.headerBody}>
          <Text style={styles.supplierName}>
            {header.suppliers?.name ?? 'Unknown Supplier'}
          </Text>
          <View style={styles.headerMeta}>
            <StatusBadge status={header.status} />
            <Text style={styles.deliveryText}>
              Expected: {formatDate(header.expected_delivery)}
            </Text>
          </View>
        </View>
      </View>

      {/* Lines */}
      <FlatList
        data={lines}
        keyExtractor={(item) => item.po_line_id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <POLineCard
            line={item}
            expanded={expandedLineId === item.po_line_id}
            form={
              forms[item.po_line_id] ?? {
                receivedQty: '',
                damagedQty: '',
                unitCost: '',
              }
            }
            submitting={submittingIds.has(item.po_line_id)}
            pendingSync={pendingSyncIds.has(item.po_line_id)}
            onToggle={() => toggleLine(item.po_line_id)}
            onFormChange={(field, value) =>
              handleFormChange(item.po_line_id, field, value)
            }
            onConfirm={() => handleConfirm(item)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No lines on this purchase order.</Text>
          </View>
        }
      />
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles — screen level
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F9FAFB',
    padding: 24,
  },
  errorText: {
    color: '#DC2626',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 16,
  },
  backBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#6366F1',
    borderRadius: 8,
  },
  backBtnText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  header: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
    paddingTop: 52,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  backTouchable: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  backArrow: {
    fontSize: 24,
    color: '#6366F1',
    lineHeight: 28,
    marginRight: 2,
  },
  backLabel: {
    fontSize: 15,
    color: '#6366F1',
  },
  headerBody: {
    gap: 6,
  },
  supplierName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
  },
  headerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  deliveryText: {
    fontSize: 13,
    color: '#6B7280',
  },
  listContent: {
    padding: 12,
    gap: 10,
    paddingBottom: 40,
  },
  emptyState: {
    paddingVertical: 60,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 15,
    color: '#6B7280',
  },
});

// ---------------------------------------------------------------------------
// Styles — POLineCard
// ---------------------------------------------------------------------------

const linestyles = StyleSheet.create({
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
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  productInfo: {
    flex: 1,
    marginRight: 10,
  },
  productName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  qtyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  qtyLabel: {
    fontSize: 12,
    color: '#6B7280',
  },
  qtyValue: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  qtyDivider: {
    fontSize: 12,
    color: '#D1D5DB',
  },
  qtyRemaining: {
    color: '#D97706',
  },
  qtyDone: {
    color: '#059669',
  },
  rightCol: {
    alignItems: 'flex-end',
    gap: 8,
  },
  badge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  receiveBtn: {
    backgroundColor: '#EEF2FF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  receiveBtnText: {
    color: '#6366F1',
    fontSize: 13,
    fontWeight: '600',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E7EB',
    marginVertical: 12,
  },
  form: {
    marginTop: 2,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  fieldLabel: {
    fontSize: 14,
    color: '#374151',
    flex: 1,
  },
  input: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: '#111827',
    width: 120,
    textAlign: 'right',
    backgroundColor: '#F9FAFB',
  },
  pendingBanner: {
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    padding: 8,
    marginBottom: 10,
    alignItems: 'center',
  },
  pendingText: {
    fontSize: 13,
    color: '#92400E',
    fontWeight: '500',
  },
  confirmBtn: {
    backgroundColor: '#6366F1',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  confirmBtnDisabled: {
    backgroundColor: '#A5B4FC',
  },
  confirmBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
