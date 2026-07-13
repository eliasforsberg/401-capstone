/**
 * Purchase Order detail screen.
 *
 * Shows:
 *   - PO header: supplier name, status badge, created date, expected delivery, notes
 *   - Line items: product name, ordered qty, received qty, unit cost, status
 *   - Action buttons (role + status conditional):
 *       Draft + owner/purchasing  → Edit, Submit, Cancel
 *       Submitted + owner/purchasing → Cancel
 *       Received → no action buttons (locked)
 *   - Submit / Cancel confirmation dialogs
 *   - MOQ warning banner when a line quantity is below supplier.minimum_order_qty
 *   - Attachments section (existing files + "Add Receipt" upload to po-attachments bucket)
 *   - Inventory movements referencing this PO
 *
 * Requirements: 8.2, 8.3, 8.4, 8.7
 */

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';

import {
  usePurchaseOrder,
  useSubmitPO,
  useCancelPO,
  type POLine,
  type PurchaseOrderWithLines,
} from '@/hooks/usePurchaseOrders';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { PurchaseOrderStatus, UserRole } from '@/types';

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

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

const LINE_STATUS_DISPLAY: Record<string, string> = {
  pending: 'Pending',
  partially_received: 'Partial',
  received: 'Received',
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function canEditOrSubmit(status: PurchaseOrderStatus, role: UserRole | null): boolean {
  return status === 'draft' && (role === 'owner' || role === 'purchasing');
}

function canCancel(status: PurchaseOrderStatus, role: UserRole | null): boolean {
  return (
    (status === 'draft' || status === 'submitted') &&
    (role === 'owner' || role === 'purchasing')
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? { bg: '#F3F4F6', text: '#374151' };
  return (
    <View style={[styles.badge, { backgroundColor: colors.bg }]}>
      <Text style={[styles.badgeText, { color: colors.text }]}>
        {STATUS_DISPLAY[status] ?? status}
      </Text>
    </View>
  );
}

function LineBadge({ status }: { status: string }) {
  const palette: Record<string, { bg: string; text: string }> = {
    pending: { bg: '#F3F4F6', text: '#6B7280' },
    partially_received: { bg: '#FEF3C7', text: '#92400E' },
    received: { bg: '#D1FAE5', text: '#065F46' },
  };
  const colors = palette[status] ?? { bg: '#F3F4F6', text: '#6B7280' };
  return (
    <View style={[styles.lineBadge, { backgroundColor: colors.bg }]}>
      <Text style={[styles.lineBadgeText, { color: colors.text }]}>
        {LINE_STATUS_DISPLAY[status] ?? status}
      </Text>
    </View>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function POLineCard({
  line,
  moqWarning,
}: {
  line: POLine;
  moqWarning: boolean;
}) {
  return (
    <View style={styles.lineCard}>
      {moqWarning && (
        <View style={styles.moqWarning}>
          <Text style={styles.moqWarningText}>
            ⚠️ Quantity below minimum order quantity
          </Text>
        </View>
      )}
      <View style={styles.lineHeader}>
        <Text style={styles.lineName} numberOfLines={2}>
          {line.product_name}
        </Text>
        <LineBadge status={line.status} />
      </View>
      <Text style={styles.lineSku}>{line.product_sku}</Text>
      <View style={styles.lineQtyRow}>
        <View style={styles.lineQtyItem}>
          <Text style={styles.lineQtyLabel}>Ordered</Text>
          <Text style={styles.lineQtyValue}>{line.ordered_quantity}</Text>
        </View>
        <View style={styles.lineQtyDivider} />
        <View style={styles.lineQtyItem}>
          <Text style={styles.lineQtyLabel}>Received</Text>
          <Text style={styles.lineQtyValue}>{line.received_quantity}</Text>
        </View>
        <View style={styles.lineQtyDivider} />
        <View style={styles.lineQtyItem}>
          <Text style={styles.lineQtyLabel}>Unit Cost</Text>
          <Text style={styles.lineQtyValue}>
            {line.unit_cost != null ? `$${line.unit_cost.toFixed(2)}` : '—'}
          </Text>
        </View>
      </View>
      {line.rationale_text ? (
        <Text style={styles.rationale}>{line.rationale_text}</Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Movement type for the "View Movements" section
// ---------------------------------------------------------------------------

interface InventoryMovement {
  movement_id: string;
  movement_type: string;
  quantity_delta: number;
  created_at: string;
  products: { name: string; sku: string } | null;
}

// ---------------------------------------------------------------------------
// Attachments helpers
// ---------------------------------------------------------------------------

/** Upload a local file URI to Supabase Storage under po-attachments/<poId>/ */
async function uploadAttachment(
  poId: string,
  assetUri: string,
  fileName: string,
): Promise<string> {
  // Fetch the file as a blob
  const response = await fetch(assetUri);
  const blob = await response.blob();
  const path = `${poId}/${Date.now()}-${fileName}`;

  const { error } = await supabase.storage
    .from('po-attachments')
    .upload(path, blob, { upsert: false });

  if (error) throw new Error(error.message);
  return path;
}

/** Persist updated attachment_paths back to the purchase_orders row. */
async function saveAttachmentPaths(poId: string, paths: string[]): Promise<void> {
  const { error } = await supabase
    .from('purchase_orders')
    .update({ attachment_paths: paths, updated_at: new Date().toISOString() })
    .eq('po_id', poId);

  if (error) throw new Error(error.message);
}

/** Get a signed URL for viewing an attachment (valid 60 s). */
async function getSignedUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage
    .from('po-attachments')
    .createSignedUrl(path, 60);
  return data?.signedUrl ?? null;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function PODetailScreen() {
  const { poId } = useLocalSearchParams<{ poId: string }>();
  const role = useAuthStore((s) => s.role);

  const { data: po, isLoading, error, refetch } = usePurchaseOrder(poId ?? '');
  const submitMutation = useSubmitPO();
  const cancelMutation = useCancelPO();

  // Movements referencing this PO
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [movementsLoaded, setMovementsLoaded] = useState(false);

  // Attachment state (driven from po.attachment_paths)
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  // ---------------------------------------------------------------------------
  // Load movements on demand
  // ---------------------------------------------------------------------------
  const loadMovements = useCallback(async () => {
    if (!poId) return;
    const { data } = await supabase
      .from('inventory_movements')
      .select(
        `movement_id, movement_type, quantity_delta, created_at,
         products ( name, sku )`,
      )
      .eq('reference_id', poId)
      .order('created_at', { ascending: false })
      .limit(50);

    setMovements((data as unknown as InventoryMovement[]) ?? []);
    setMovementsLoaded(true);
  }, [poId]);

  // ---------------------------------------------------------------------------
  // Submit PO
  // ---------------------------------------------------------------------------
  function handleSubmit() {
    Alert.alert(
      'Submit Purchase Order',
      'This will lock the PO and send it to the supplier. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Submit',
          style: 'default',
          onPress: () => {
            submitMutation.mutate(poId!, {
              onSuccess: () => {
                Alert.alert('Submitted', 'Purchase order has been submitted.');
              },
              onError: (err: unknown) => {
                Alert.alert(
                  'Submit failed',
                  err instanceof Error ? err.message : 'Something went wrong.',
                );
              },
            });
          },
        },
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // Cancel PO
  // ---------------------------------------------------------------------------
  function handleCancel() {
    Alert.alert(
      'Cancel Purchase Order',
      'Are you sure you want to cancel this PO? This cannot be undone.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel PO',
          style: 'destructive',
          onPress: () => {
            cancelMutation.mutate(poId!, {
              onSuccess: () => {
                Alert.alert('Cancelled', 'Purchase order has been cancelled.', [
                  { text: 'OK', onPress: () => router.back() },
                ]);
              },
              onError: (err: unknown) => {
                Alert.alert(
                  'Cancellation failed',
                  err instanceof Error ? err.message : 'Something went wrong.',
                );
              },
            });
          },
        },
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // Add receipt attachment
  // ---------------------------------------------------------------------------
  const handleAddReceipt = useCallback(async () => {
    if (!po) return;

    // Request media library permission via expo-image-picker
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission required', 'Allow access to your photo library to upload receipts.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsMultipleSelection: false,
    });

    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    const fileName = asset.fileName ?? `receipt-${Date.now()}.jpg`;

    setUploadingAttachment(true);
    try {
      const storagePath = await uploadAttachment(po.po_id, asset.uri, fileName);
      const existing = po.attachment_paths ?? [];
      const updated = [...existing, storagePath];
      await saveAttachmentPaths(po.po_id, updated);
      await refetch();
    } catch (err: unknown) {
      Alert.alert(
        'Upload failed',
        err instanceof Error ? err.message : 'Could not upload receipt.',
      );
    } finally {
      setUploadingAttachment(false);
    }
  }, [po, refetch]);

  // ---------------------------------------------------------------------------
  // View attachment
  // ---------------------------------------------------------------------------
  const handleViewAttachment = useCallback(async (path: string) => {
    const url = await getSignedUrl(path);
    if (url) {
      await Linking.openURL(url);
    } else {
      Alert.alert('Error', 'Could not open attachment.');
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------
  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  if (error || !po) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>
          {error instanceof Error ? error.message : 'Purchase order not found.'}
        </Text>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const moq = po.suppliers?.minimum_order_qty ?? 0;
  const isBusy = submitMutation.isPending || cancelMutation.isPending;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <View style={styles.root}>
      {/* ---- Back + header ---- */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backTouchable}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Text style={styles.backArrow}>‹</Text>
          <Text style={styles.backLabel}>Orders</Text>
        </TouchableOpacity>
        <View style={styles.headerBody}>
          <View style={styles.headerTitleRow}>
            <Text style={styles.supplierName} numberOfLines={1}>
              {po.suppliers?.name ?? 'Unknown Supplier'}
            </Text>
            <StatusBadge status={po.status} />
          </View>
          <Text style={styles.headerSub}>
            Created {formatDate(po.created_at)}
            {po.submitted_at ? `  ·  Submitted ${formatDate(po.submitted_at)}` : ''}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ---- PO Info ---- */}
        <View style={styles.card}>
          <InfoRow label="Expected delivery" value={formatDate(po.expected_delivery)} />
          {po.notes ? <InfoRow label="Notes" value={po.notes} /> : null}
          {po.suppliers?.lead_time_days != null && (
            <InfoRow
              label="Supplier lead time"
              value={`${po.suppliers.lead_time_days} days`}
            />
          )}
          {moq > 0 && (
            <InfoRow label="Min order qty (supplier)" value={String(moq)} />
          )}
        </View>

        {/* ---- Line items ---- */}
        <SectionHeader title={`Lines (${po.lines.length})`} />
        {po.lines.length === 0 ? (
          <View style={styles.emptySection}>
            <Text style={styles.emptySectionText}>No line items on this PO.</Text>
          </View>
        ) : (
          po.lines.map((line) => (
            <POLineCard
              key={line.po_line_id}
              line={line}
              moqWarning={moq > 0 && line.ordered_quantity < moq}
            />
          ))
        )}

        {/* ---- Attachments ---- */}
        <SectionHeader title="Attachments" />
        <View style={styles.card}>
          {(po.attachment_paths ?? []).length === 0 ? (
            <Text style={styles.noAttachments}>No receipts attached.</Text>
          ) : (
            (po.attachment_paths ?? []).map((path, idx) => {
              const fileName = path.split('/').pop() ?? path;
              return (
                <TouchableOpacity
                  key={idx}
                  style={styles.attachmentRow}
                  onPress={() => void handleViewAttachment(path)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.attachmentName} numberOfLines={1}>
                    📎 {fileName}
                  </Text>
                  <Text style={styles.attachmentView}>View</Text>
                </TouchableOpacity>
              );
            })
          )}

          {po.status !== 'received' && po.status !== 'cancelled' && (
            <TouchableOpacity
              style={[
                styles.addReceiptButton,
                uploadingAttachment && styles.addReceiptButtonDisabled,
              ]}
              onPress={() => void handleAddReceipt()}
              disabled={uploadingAttachment}
              activeOpacity={0.8}
            >
              {uploadingAttachment ? (
                <ActivityIndicator color="#6366F1" size="small" />
              ) : (
                <Text style={styles.addReceiptText}>+ Add Receipt</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* ---- Inventory Movements ---- */}
        <SectionHeader title="Inventory Movements" />
        <View style={styles.card}>
          {!movementsLoaded ? (
            <TouchableOpacity
              style={styles.loadMovementsButton}
              onPress={() => void loadMovements()}
              activeOpacity={0.8}
            >
              <Text style={styles.loadMovementsText}>Load Movements</Text>
            </TouchableOpacity>
          ) : movements.length === 0 ? (
            <Text style={styles.noAttachments}>No movements linked to this PO.</Text>
          ) : (
            movements.map((mv) => (
              <View key={mv.movement_id} style={styles.movementRow}>
                <View style={styles.movementLeft}>
                  <Text style={styles.movementProduct}>
                    {mv.products?.name ?? 'Unknown'}
                  </Text>
                  <Text style={styles.movementMeta}>
                    {mv.movement_type} · {formatDate(mv.created_at)}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.movementDelta,
                    mv.quantity_delta >= 0 ? styles.deltaPositive : styles.deltaNegative,
                  ]}
                >
                  {mv.quantity_delta >= 0 ? '+' : ''}
                  {mv.quantity_delta}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* ---- Action buttons ---- */}
        {(canEditOrSubmit(po.status, role) || canCancel(po.status, role)) && (
          <View style={styles.actionSection}>
            {canEditOrSubmit(po.status, role) && (
              <>
                <TouchableOpacity
                  style={styles.editButton}
                  onPress={() => router.push(`/(app)/orders/new?editPoId=${poId}`)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.editButtonText}>Edit PO</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.submitButton, isBusy && styles.buttonDisabled]}
                  onPress={handleSubmit}
                  disabled={isBusy}
                  activeOpacity={0.8}
                >
                  {submitMutation.isPending ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.submitButtonText}>Submit PO</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            {canCancel(po.status, role) && (
              <TouchableOpacity
                style={[styles.cancelButton, isBusy && styles.buttonDisabled]}
                onPress={handleCancel}
                disabled={isBusy}
                activeOpacity={0.8}
              >
                {cancelMutation.isPending ? (
                  <ActivityIndicator color="#DC2626" size="small" />
                ) : (
                  <Text style={styles.cancelButtonText}>Cancel PO</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={styles.bottomSpacer} />
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
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
  backButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#6366F1',
    borderRadius: 8,
  },
  backButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },

  // Header
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
    gap: 4,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  supplierName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
  },
  headerSub: {
    fontSize: 13,
    color: '#6B7280',
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

  // Scroll
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
    gap: 8,
  },
  bottomSpacer: {
    height: 40,
  },

  // Generic card
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    gap: 8,
  },

  // Info rows (PO metadata)
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  infoLabel: {
    fontSize: 13,
    color: '#6B7280',
    flex: 1,
  },
  infoValue: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '500',
    flex: 2,
    textAlign: 'right',
  },

  // Section headers
  sectionHeader: {
    paddingHorizontal: 2,
    paddingTop: 4,
    paddingBottom: 2,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // PO line card
  lineCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    gap: 6,
  },
  moqWarning: {
    backgroundColor: '#FEF3C7',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  moqWarningText: {
    fontSize: 12,
    color: '#92400E',
    fontWeight: '500',
  },
  lineHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  lineName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
    flex: 1,
  },
  lineSku: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  lineQtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  lineQtyItem: {
    flex: 1,
    alignItems: 'center',
  },
  lineQtyDivider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    backgroundColor: '#E5E7EB',
  },
  lineQtyLabel: {
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 2,
  },
  lineQtyValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  lineBadge: {
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  lineBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  rationale: {
    fontSize: 12,
    color: '#6B7280',
    fontStyle: 'italic',
    marginTop: 4,
  },

  // Attachments
  noAttachments: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    paddingVertical: 4,
  },
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F3F4F6',
  },
  attachmentName: {
    fontSize: 14,
    color: '#374151',
    flex: 1,
    marginRight: 8,
  },
  attachmentView: {
    fontSize: 13,
    color: '#6366F1',
    fontWeight: '600',
  },
  addReceiptButton: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#6366F1',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  addReceiptButtonDisabled: {
    borderColor: '#A5B4FC',
  },
  addReceiptText: {
    color: '#6366F1',
    fontSize: 14,
    fontWeight: '600',
  },

  // Movements
  loadMovementsButton: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  loadMovementsText: {
    color: '#6366F1',
    fontSize: 14,
    fontWeight: '600',
  },
  movementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F3F4F6',
  },
  movementLeft: {
    flex: 1,
    marginRight: 8,
  },
  movementProduct: {
    fontSize: 14,
    color: '#111827',
    fontWeight: '500',
  },
  movementMeta: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 1,
  },
  movementDelta: {
    fontSize: 15,
    fontWeight: '700',
  },
  deltaPositive: {
    color: '#059669',
  },
  deltaNegative: {
    color: '#DC2626',
  },

  // Action buttons
  actionSection: {
    gap: 10,
    marginTop: 4,
  },
  editButton: {
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  editButtonText: {
    color: '#374151',
    fontSize: 16,
    fontWeight: '600',
  },
  submitButton: {
    backgroundColor: '#6366F1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#DC2626',
  },
  cancelButtonText: {
    color: '#DC2626',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },

  emptySection: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  emptySectionText: {
    fontSize: 14,
    color: '#9CA3AF',
  },
});
