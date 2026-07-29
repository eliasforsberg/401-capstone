/**
 * Product detail screen.
 *
 * Shows:
 *  - Product header (name, SKU, category)
 *  - Balance card (large current quantity)
 *  - Reorder settings (editable for Owner / Purchasing, read-only otherwise)
 *  - Barcode list
 *  - Recent movements (last 10)
 *  - "Adjust Stock" button (placeholder for task 16.3)
 *
 * Requirements: 4.4, 7.8
 */

import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Alert,
} from 'react-native';

import { useProduct, useUpdateProduct } from '@/hooks/useProducts';
import type { Product } from '@/hooks/useProducts';
import { useSuppliers } from '@/hooks/useSuppliers';
import { useMovementHistory } from '@/hooks/useInventory';
import type { InventoryMovement } from '@/lib/inventoryService';
import { getCachedProductById } from '@/lib/catalogCache';
import { useAuthStore } from '@/stores/authStore';
import { supabase } from '@/lib/supabase';
import { useQueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Roles that can edit reorder settings (Requirement 4.4, 9.2). */
function canEdit(role: string | null): boolean {
  return role === 'owner' || role === 'purchasing';
}

/** Format an ISO date string into a human-readable short form. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Map a movement type to a label and sign color. */
function movementMeta(type: InventoryMovement['movement_type']): {
  label: string;
  color: string;
} {
  switch (type) {
    case 'receive':
      return { label: 'Receive', color: '#16a34a' };
    case 'sale':
      return { label: 'Sale', color: '#dc2626' };
    case 'return':
      return { label: 'Return', color: '#2563eb' };
    case 'adjustment':
      return { label: 'Adjustment', color: '#d97706' };
    case 'count_correction':
      return { label: 'Count', color: '#7c3aed' };
    case 'transfer':
      return { label: 'Transfer', color: '#0891b2' };
    default:
      return { label: type, color: '#6b7280' };
  }
}

// ---------------------------------------------------------------------------
// Reorder settings form
// ---------------------------------------------------------------------------

interface ReorderSettings {
  reorder_point: string;
  reorder_quantity: string;
  safety_stock: string;
  lead_time_days: string;
  default_supplier_id: string;
}

function productToFormValues(product: Product): ReorderSettings {
  return {
    reorder_point: String(product.reorder_point),
    reorder_quantity: String(product.reorder_quantity),
    safety_stock: String(product.safety_stock),
    lead_time_days: product.lead_time_days != null ? String(product.lead_time_days) : '',
    default_supplier_id: product.default_supplier_id ?? '',
  };
}

// ---------------------------------------------------------------------------
// ReorderField sub-component
// ---------------------------------------------------------------------------

interface ReorderFieldProps {
  label: string;
  value: string;
  editable: boolean;
  onChange?: (v: string) => void;
  keyboardType?: 'numeric' | 'default';
  suffix?: string;
}

function ReorderField({ label, value, editable, onChange, keyboardType = 'numeric', suffix }: ReorderFieldProps) {
  if (!editable) {
    return (
      <View style={fieldStyles.row}>
        <Text style={fieldStyles.label}>{label}</Text>
        <Text style={fieldStyles.valueText}>
          {value || '—'}{suffix ? ` ${suffix}` : ''}
        </Text>
      </View>
    );
  }
  return (
    <View style={fieldStyles.row}>
      <Text style={fieldStyles.label}>{label}</Text>
      <View style={fieldStyles.inputWrapper}>
        <TextInput
          style={fieldStyles.input}
          value={value}
          onChangeText={onChange}
          keyboardType={keyboardType}
          placeholder="—"
          placeholderTextColor="#9ca3af"
          accessibilityLabel={label}
        />
        {suffix ? <Text style={fieldStyles.suffix}>{suffix}</Text> : null}
      </View>
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e7eb' },
  label: { fontSize: 14, color: '#374151', flex: 1 },
  valueText: { fontSize: 14, fontWeight: '600', color: '#111827', textAlign: 'right' },
  inputWrapper: { flexDirection: 'row', alignItems: 'center' },
  input: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14, color: '#111827', minWidth: 80, textAlign: 'right', backgroundColor: '#ffffff' },
  suffix: { fontSize: 13, color: '#6b7280', marginLeft: 6 },
});

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function ProductDetailScreen() {
  const { skuId } = useLocalSearchParams<{ skuId: string }>();
  const router = useRouter();
  const role = useAuthStore((s) => s.role);
  const editable = canEdit(role);

  const { data: product, isLoading: productLoading, error: productError } = useProduct(skuId);
  // useBalance returns number (via inventoryService.getBalance).
  // In the single-store MVP we don't have a locationId in the URL; instead we
  // derive balance from the inventory_balances table via a direct Supabase query.
  const [currentQty, setCurrentQty] = useState<number>(0);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [balanceSyncedAt, setBalanceSyncedAt] = useState<string | null>(null);
  const [balanceFromCache, setBalanceFromCache] = useState(false);

  const { data: movements, isLoading: movementsLoading } = useMovementHistory(skuId, {
    limit: 10,
  });
  const { data: suppliers } = useSuppliers();
  const updateProduct = useUpdateProduct();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<ReorderSettings>({
    reorder_point: '', reorder_quantity: '', safety_stock: '', lead_time_days: '', default_supplier_id: '',
  });
  const [formDirty, setFormDirty] = useState(false);
  const [barcodes, setBarcodes] = useState<string[]>([]);

  // Initialise form from product data
  useEffect(() => {
    if (product) {
      setForm(productToFormValues(product));
      setFormDirty(false);
    }
  }, [product]);

  // Load balance — network first; fall back to MMKV catalog cache when offline.
  // When showing a cached balance, track `balanceSyncedAt` so the UI can
  // display "balance as of [time]" (Requirement 13.3).
  const fetchBalance = useCallback(() => {
    if (!skuId) return;
    setBalanceLoading(true);

    const businessId = useAuthStore.getState().businessId;

    supabase
      .from('inventory_balances')
      .select('quantity')
      .eq('sku_id', skuId)
      .eq('business_id', businessId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!error && data != null) {
          // Network success — fresh balance
          setCurrentQty(Number(data.quantity));
          setBalanceSyncedAt(null);
          setBalanceFromCache(false);
        } else {
          // Network unavailable or no row — fall back to MMKV cache
          const cached = getCachedProductById(skuId);
          if (cached) {
            setCurrentQty(cached.balance);
            setBalanceSyncedAt(cached.balanceSyncedAt);
            setBalanceFromCache(true);
          } else {
            setCurrentQty(0);
            setBalanceSyncedAt(null);
            setBalanceFromCache(false);
          }
        }
        setBalanceLoading(false);
      })
      .then(undefined, () => {
        // Fetch threw — treat as offline
        const cached = getCachedProductById(skuId);
        if (cached) {
          setCurrentQty(cached.balance);
          setBalanceSyncedAt(cached.balanceSyncedAt);
          setBalanceFromCache(true);
        }
        setBalanceLoading(false);
      });
  }, [skuId]);

  // Re-fetch balance on mount and whenever the screen regains focus
  // (e.g. returning from the Adjust Stock screen).
  useFocusEffect(
    useCallback(() => {
      fetchBalance();
      // Also refresh movements list so new adjustments appear immediately
      queryClient.invalidateQueries({ queryKey: ['movements', skuId] });
    }, [fetchBalance, queryClient, skuId])
  );

  // Load barcodes
  useEffect(() => {
    if (!skuId) return;
    const businessId = useAuthStore.getState().businessId;
    supabase
      .from('product_barcodes')
      .select('barcode_value')
      .eq('sku_id', skuId)
      .eq('business_id', businessId)
      .then(({ data }) => {
        if (data) setBarcodes(data.map((b: { barcode_value: string }) => b.barcode_value));
      });
  }, [skuId]);

  const handleFieldChange = useCallback((field: keyof ReorderSettings, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFormDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!product) return;
    const reorder_point = parseInt(form.reorder_point, 10);
    const reorder_quantity = parseInt(form.reorder_quantity, 10);
    const safety_stock = parseInt(form.safety_stock, 10);
    const lead_time_days_val = form.lead_time_days ? parseInt(form.lead_time_days, 10) : undefined;
    if (isNaN(reorder_point) || isNaN(reorder_quantity) || isNaN(safety_stock)) {
      Alert.alert('Invalid input', 'Reorder point, quantity, and safety stock must be numbers.');
      return;
    }
    try {
      await updateProduct.mutateAsync({
        productId: product.product_id,
        updates: {
          reorder_point,
          reorder_quantity,
          safety_stock,
          lead_time_days: lead_time_days_val,
          default_supplier_id: form.default_supplier_id || undefined,
        },
      });
      setFormDirty(false);
      Alert.alert('Saved', 'Reorder settings updated.');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Unknown error');
    }
  }, [product, form, updateProduct]);

  const handleAdjustStock = useCallback(() => {
    router.push(`/(app)/inventory/adjust?skuId=${skuId}`);
  }, [router, skuId]);

  const handleDeleteProduct = useCallback(() => {
    Alert.alert(
      'Delete Product',
      `Are you sure you want to remove "${product?.name ?? 'this product'}" from inventory? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const { error } = await supabase
                .from('products')
                .update({ is_active: false, updated_at: new Date().toISOString() })
                .eq('product_id', skuId);

              if (error) throw error;

              // Invalidate caches so the product disappears from lists
              queryClient.invalidateQueries({ queryKey: ['products'] });
              queryClient.invalidateQueries({ queryKey: ['stock-on-hand'] });

              Alert.alert('Deleted', 'Product has been removed from inventory.');
              router.replace('/(app)/inventory');
            } catch (err) {
              Alert.alert(
                'Error',
                err instanceof Error ? err.message : 'Failed to delete product.',
              );
            }
          },
        },
      ],
    );
  }, [skuId, product, queryClient, router]);

  // Loading / error states
  if (productLoading) {
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator size="large" color="#6366f1" />
      </View>
    );
  }
  if (productError || !product) {
    return (
      <View style={styles.centeredContainer}>
        <Text style={styles.errorText}>
          {productError instanceof Error ? productError.message : 'Product not found.'}
        </Text>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isOutOfStock = currentQty <= 0;
  const isLowStock = !isOutOfStock && currentQty <= product.reorder_point;
  const defaultSupplierName =
    suppliers?.find((s) => s.supplier_id === product.default_supplier_id)?.name ?? '—';

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

        {/* Back navigation */}
        <TouchableOpacity style={styles.backRow} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back to inventory list">
          <Text style={styles.backChevron}>‹</Text>
          <Text style={styles.backText}>Inventory</Text>
        </TouchableOpacity>

        {/* Product header */}
        <View style={styles.headerCard}>
          <Text style={styles.productName}>{product.name}</Text>
          <Text style={styles.productSku}>SKU: {product.sku}</Text>
          {product.category ? (
            <View style={styles.categoryBadge}>
              <Text style={styles.categoryBadgeText}>{product.category}</Text>
            </View>
          ) : null}
        </View>

        {/* Balance card */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Stock on Hand</Text>
          <View style={[styles.balanceCard, isOutOfStock && styles.balanceCardOos, isLowStock && styles.balanceCardLow]}>
            {balanceLoading ? (
              <ActivityIndicator color="#6366f1" />
            ) : (
              <>
                <Text style={[styles.balanceQty, isOutOfStock && styles.balanceQtyOos, isLowStock && styles.balanceQtyLow]}>
                  {currentQty}
                </Text>
                <Text style={styles.balanceUnit}>{product.unit_of_measure}</Text>
                {isOutOfStock && <Text style={styles.balanceStatusOos}>OUT OF STOCK</Text>}
                {isLowStock && <Text style={styles.balanceStatusLow}>LOW STOCK</Text>}
                {/* Show stale-data notice when balance is served from MMKV cache (offline) */}
                {balanceFromCache && balanceSyncedAt && (
                  <Text style={styles.balanceStaleBadge}>
                    Balance as of {formatDate(balanceSyncedAt)} (offline)
                  </Text>
                )}
              </>
            )}
          </View>
        </View>

        {/* Reorder settings */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Reorder Settings</Text>
            {editable && formDirty && (
              <Pressable
                onPress={handleSave}
                disabled={updateProduct.isPending}
                style={({ pressed }) => [styles.saveButton, pressed && styles.saveButtonPressed]}
                accessibilityRole="button"
                accessibilityLabel="Save reorder settings"
              >
                {updateProduct.isPending ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Text style={styles.saveButtonText}>Save</Text>
                )}
              </Pressable>
            )}
          </View>
          <View style={styles.card}>
            <ReorderField label="Reorder point" value={form.reorder_point} editable={editable} onChange={(v) => handleFieldChange('reorder_point', v)} suffix={product.unit_of_measure} />
            <ReorderField label="Reorder quantity" value={form.reorder_quantity} editable={editable} onChange={(v) => handleFieldChange('reorder_quantity', v)} suffix={product.unit_of_measure} />
            <ReorderField label="Safety stock" value={form.safety_stock} editable={editable} onChange={(v) => handleFieldChange('safety_stock', v)} suffix={product.unit_of_measure} />
            <ReorderField label="Lead time" value={form.lead_time_days} editable={editable} onChange={(v) => handleFieldChange('lead_time_days', v)} suffix="days" />
            {editable ? (
              <View style={fieldStyles.row}>
                <Text style={fieldStyles.label}>Default supplier</Text>
                <View style={styles.supplierButtons}>
                  {!suppliers || suppliers.length === 0 ? (
                    <Text style={styles.noSuppliersText}>No suppliers</Text>
                  ) : (
                    suppliers.map((s) => (
                      <Pressable
                        key={s.supplier_id}
                        onPress={() => handleFieldChange('default_supplier_id', s.supplier_id)}
                        style={[styles.supplierChip, form.default_supplier_id === s.supplier_id && styles.supplierChipSelected]}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: form.default_supplier_id === s.supplier_id }}
                        accessibilityLabel={`Supplier: ${s.name}`}
                      >
                        <Text style={[styles.supplierChipText, form.default_supplier_id === s.supplier_id && styles.supplierChipTextSelected]} numberOfLines={1}>
                          {s.name}
                        </Text>
                      </Pressable>
                    ))
                  )}
                </View>
              </View>
            ) : (
              <View style={fieldStyles.row}>
                <Text style={fieldStyles.label}>Default supplier</Text>
                <Text style={fieldStyles.valueText}>{defaultSupplierName}</Text>
              </View>
            )}
          </View>
          {!editable && <Text style={styles.editHint}>Only Owners and Purchasing users can edit reorder settings.</Text>}
        </View>

        {/* Barcode list */}
        {barcodes.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Barcodes</Text>
            <View style={styles.card}>
              {barcodes.map((barcode, i) => (
                <View key={barcode} style={[styles.barcodeRow, i < barcodes.length - 1 && styles.barcodeRowBorder]}>
                  <Text style={styles.barcodeText}>{barcode}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Recent movements */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent Movements</Text>
          {movementsLoading ? (
            <ActivityIndicator style={styles.loadingSpinner} color="#6366f1" />
          ) : !movements || movements.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.noMovementsText}>No movements recorded yet.</Text>
            </View>
          ) : (
            <View style={styles.card}>
              {movements.map((m, i) => {
                const meta = movementMeta(m.movement_type);
                const isPositive = m.quantity_delta > 0;
                return (
                  <View key={m.movement_id} style={[styles.movementRow, i < movements.length - 1 && styles.movementRowBorder]}>
                    <View style={styles.movementLeft}>
                      <Text style={[styles.movementType, { color: meta.color }]}>{meta.label}</Text>
                      <Text style={styles.movementDate}>{formatDate(m.created_at)}</Text>
                      {m.notes ? <Text style={styles.movementNotes} numberOfLines={1}>{m.notes}</Text> : null}
                    </View>
                    <Text style={[styles.movementDelta, isPositive ? styles.movementDeltaPos : styles.movementDeltaNeg]}>
                      {isPositive ? '+' : ''}{m.quantity_delta}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </View>

        {/* Adjust stock button */}
        <View style={styles.adjustButtonContainer}>
          <TouchableOpacity style={styles.adjustButton} onPress={handleAdjustStock} accessibilityRole="button" accessibilityLabel="Adjust stock quantity">
            <Text style={styles.adjustButtonText}>Adjust Stock</Text>
          </TouchableOpacity>
        </View>

        {/* Delete product button */}
        <View style={styles.deleteButtonContainer}>
          <TouchableOpacity style={styles.deleteButton} onPress={handleDeleteProduct} accessibilityRole="button" accessibilityLabel="Delete product from inventory">
            <Text style={styles.deleteButtonText}>Delete Product</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.bottomPadding} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#f9fafb' },
  scrollContent: { paddingBottom: 40 },
  centeredContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { fontSize: 15, color: '#dc2626', textAlign: 'center', marginBottom: 16 },
  backButton: { paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#6366f1', borderRadius: 8 },
  backButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 15 },
  backRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 56, paddingHorizontal: 16, paddingBottom: 8, backgroundColor: '#ffffff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e7eb' },
  backChevron: { fontSize: 28, color: '#6366f1', lineHeight: 32, marginRight: 4 },
  backText: { fontSize: 16, color: '#6366f1', fontWeight: '500' },
  headerCard: { backgroundColor: '#ffffff', paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e7eb' },
  productName: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 4 },
  productSku: { fontSize: 14, color: '#6b7280', marginBottom: 6 },
  categoryBadge: { alignSelf: 'flex-start', backgroundColor: '#ede9fe', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  categoryBadgeText: { fontSize: 12, fontWeight: '600', color: '#7c3aed', textTransform: 'capitalize' },
  section: { marginTop: 20, paddingHorizontal: 16 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },
  card: { backgroundColor: '#ffffff', borderRadius: 12, paddingHorizontal: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  balanceCard: { backgroundColor: '#ffffff', borderRadius: 16, paddingVertical: 28, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 6, elevation: 3 },
  balanceCardLow: { backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fcd34d' },
  balanceCardOos: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fca5a5' },
  balanceQty: { fontSize: 64, fontWeight: '800', color: '#111827', lineHeight: 72 },
  balanceQtyLow: { color: '#d97706' },
  balanceQtyOos: { color: '#dc2626' },
  balanceUnit: { fontSize: 16, color: '#6b7280', marginTop: 4 },
  balanceStatusLow: { marginTop: 8, fontSize: 12, fontWeight: '700', color: '#d97706', letterSpacing: 0.8, textTransform: 'uppercase' },
  balanceStatusOos: { marginTop: 8, fontSize: 12, fontWeight: '700', color: '#dc2626', letterSpacing: 0.8, textTransform: 'uppercase' },
  balanceStaleBadge: { marginTop: 10, fontSize: 12, color: '#92400E', backgroundColor: '#FEF3C7', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, overflow: 'hidden', fontStyle: 'italic' },
  saveButton: { backgroundColor: '#6366f1', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7, minWidth: 60, alignItems: 'center' },
  saveButtonPressed: { opacity: 0.8 },
  saveButtonText: { color: '#ffffff', fontWeight: '700', fontSize: 14 },
  editHint: { marginTop: 8, fontSize: 12, color: '#9ca3af', fontStyle: 'italic' },
  supplierButtons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, flex: 1, marginLeft: 12 },
  supplierChip: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: '#f9fafb', maxWidth: 140 },
  supplierChipSelected: { borderColor: '#6366f1', backgroundColor: '#ede9fe' },
  supplierChipText: { fontSize: 12, color: '#374151', fontWeight: '500' },
  supplierChipTextSelected: { color: '#6366f1', fontWeight: '700' },
  noSuppliersText: { fontSize: 13, color: '#9ca3af' },
  barcodeRow: { paddingVertical: 12 },
  barcodeRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e7eb' },
  barcodeText: { fontSize: 15, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: '#111827', letterSpacing: 1 },
  movementRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  movementRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e7eb' },
  movementLeft: { flex: 1, marginRight: 12 },
  movementType: { fontSize: 14, fontWeight: '600', marginBottom: 2 },
  movementDate: { fontSize: 12, color: '#9ca3af' },
  movementNotes: { fontSize: 12, color: '#6b7280', marginTop: 2, fontStyle: 'italic' },
  movementDelta: { fontSize: 18, fontWeight: '700', minWidth: 52, textAlign: 'right' },
  movementDeltaPos: { color: '#16a34a' },
  movementDeltaNeg: { color: '#dc2626' },
  noMovementsText: { paddingVertical: 16, fontSize: 14, color: '#9ca3af', textAlign: 'center' },
  loadingSpinner: { marginVertical: 16 },
  adjustButtonContainer: { marginTop: 24, paddingHorizontal: 16 },
  adjustButton: { backgroundColor: '#111827', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  adjustButtonText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  deleteButtonContainer: { marginTop: 12, paddingHorizontal: 16 },
  deleteButton: { backgroundColor: '#fee2e2', borderRadius: 12, paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: '#fca5a5' },
  deleteButtonText: { color: '#dc2626', fontSize: 16, fontWeight: '700' },
  bottomPadding: { height: 40 },
});
