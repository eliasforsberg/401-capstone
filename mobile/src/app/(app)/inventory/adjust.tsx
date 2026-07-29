/**
 * Adjust Stock screen.
 *
 * Receives `skuId` and optional `locationId` as route params.
 * Presents a form with:
 *  - reason_code picker (segmented control style)
 *  - quantity_delta input (positive or negative)
 *  - notes TextInput (required when reason_code = 'other')
 *  - current balance display (read-only)
 *
 * On submit:
 *  - Validates fields inline
 *  - Generates idempotency key and calls `adjust-stock` Edge Function
 *  - If response status = 'pending_approval' → shows confirmation screen
 *  - If response status = 'applied'          → shows success and navigates back
 *
 * Requirements: 5.1, 5.2, 5.3
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { SUPABASE_URL } from '@/lib/constants';
import { generateIdempotencyKey } from '@/lib/idempotency';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import { useOfflineQueueStore } from '@/stores/offlineQueueStore';
import { useProduct } from '@/hooks/useProducts';

// ---------------------------------------------------------------------------
// Constants — Requirement 5.1
// ---------------------------------------------------------------------------

const REASON_CODES = [
  { value: 'damage',              label: 'Damage' },
  { value: 'spoilage',            label: 'Spoilage' },
  { value: 'theft',               label: 'Theft' },
  { value: 'counting_correction', label: 'Count Correction' },
  { value: 'supplier_shortage',   label: 'Supplier Shortage' },
  { value: 'internal_use',        label: 'Internal Use' },
  { value: 'transfer_correction', label: 'Transfer Correction' },
  { value: 'other',               label: 'Other' },
] as const;

type ReasonCode = typeof REASON_CODES[number]['value'];

// ---------------------------------------------------------------------------
// Connectivity helper (same pattern used in receive and count screens)
// ---------------------------------------------------------------------------

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
// Types
// ---------------------------------------------------------------------------

type ScreenView = 'form' | 'pending_approval' | 'pending_sync' | 'success';

// ---------------------------------------------------------------------------
// Reason code picker
// ---------------------------------------------------------------------------

interface ReasonPickerProps {
  value: ReasonCode | null;
  onChange: (code: ReasonCode) => void;
}

function ReasonPicker({ value, onChange }: ReasonPickerProps) {
  return (
    <View style={pickerStyles.grid}>
      {REASON_CODES.map((rc) => {
        const selected = value === rc.value;
        return (
          <Pressable
            key={rc.value}
            style={({ pressed }) => [
              pickerStyles.chip,
              selected && pickerStyles.chipSelected,
              pressed && pickerStyles.chipPressed,
            ]}
            onPress={() => onChange(rc.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={rc.label}
          >
            <Text
              style={[pickerStyles.chipText, selected && pickerStyles.chipTextSelected]}
              numberOfLines={2}
            >
              {rc.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const pickerStyles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderWidth: 1.5,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#f9fafb',
    minWidth: '22%',
    alignItems: 'center',
  },
  chipSelected: {
    borderColor: '#6366f1',
    backgroundColor: '#ede9fe',
  },
  chipPressed: {
    opacity: 0.75,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#374151',
    textAlign: 'center',
  },
  chipTextSelected: {
    color: '#4f46e5',
    fontWeight: '700',
  },
});

// ---------------------------------------------------------------------------
// Pending-sync confirmation view (offline queue)
// ---------------------------------------------------------------------------

function PendingSyncView({ delta, onBack }: { delta: number; onBack: () => void }) {
  const sign = delta >= 0 ? '+' : '';
  return (
    <View style={confirmStyles.container}>
      <View style={confirmStyles.iconWrap}>
        <Text style={confirmStyles.icon}>⏳</Text>
      </View>
      <Text style={confirmStyles.title}>Pending Sync</Text>
      <Text style={confirmStyles.body}>
        You&apos;re offline. The adjustment of{' '}
        <Text style={confirmStyles.boldDelta}>
          {sign}{delta}
        </Text>{' '}
        units has been saved locally and will sync automatically when you reconnect.
      </Text>
      <TouchableOpacity
        style={confirmStyles.btn}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Return to product detail"
      >
        <Text style={confirmStyles.btnText}>Back to Product</Text>
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pending-approval confirmation view
// ---------------------------------------------------------------------------

function PendingApprovalView({ onBack }: { onBack: () => void }) {
  return (
    <View style={confirmStyles.container}>
      <View style={confirmStyles.iconWrap}>
        <Text style={confirmStyles.icon}>⏳</Text>
      </View>
      <Text style={confirmStyles.title}>Pending Approval</Text>
      <Text style={confirmStyles.body}>
        Your adjustment exceeds the threshold configured by your business owner.
        It has been submitted for review and will be applied once approved.
      </Text>
      <TouchableOpacity
        style={confirmStyles.btn}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Return to product detail"
      >
        <Text style={confirmStyles.btnText}>Back to Product</Text>
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Success view
// ---------------------------------------------------------------------------

function SuccessView({ delta, onBack }: { delta: number; onBack: () => void }) {
  const sign = delta >= 0 ? '+' : '';
  return (
    <View style={confirmStyles.container}>
      <View style={[confirmStyles.iconWrap, confirmStyles.iconWrapSuccess]}>
        <Text style={confirmStyles.icon}>✓</Text>
      </View>
      <Text style={confirmStyles.title}>Adjustment Applied</Text>
      <Text style={confirmStyles.body}>
        Stock adjusted by{' '}
        <Text style={confirmStyles.boldDelta}>
          {sign}{delta}
        </Text>{' '}
        units. The inventory balance has been updated.
      </Text>
      <TouchableOpacity
        style={[confirmStyles.btn, confirmStyles.btnSuccess]}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Return to product detail"
      >
        <Text style={confirmStyles.btnText}>Back to Product</Text>
      </TouchableOpacity>
    </View>
  );
}

const confirmStyles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    backgroundColor: '#f9fafb',
  },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#fef9c3',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  iconWrapSuccess: {
    backgroundColor: '#dcfce7',
  },
  icon: {
    fontSize: 36,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    color: '#4b5563',
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 32,
  },
  boldDelta: {
    fontWeight: '700',
    color: '#111827',
  },
  btn: {
    backgroundColor: '#6366f1',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    minWidth: 200,
    alignItems: 'center',
  },
  btnSuccess: {
    backgroundColor: '#16a34a',
  },
  btnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
});

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function AdjustStockScreen() {
  const { skuId, locationId: locationIdParam } = useLocalSearchParams<{
    skuId: string;
    locationId?: string;
  }>();
  const router = useRouter();
  const businessId = useAuthStore((s) => s.businessId);
  const enqueue = useOfflineQueueStore((s) => s.enqueue);
  const queryClient = useQueryClient();

  // Fetch product info so we can display the real SKU and name
  const { data: product } = useProduct(skuId);

  // ── Form state ─────────────────────────────────────────────────────────
  const [reasonCode, setReasonCode] = useState<ReasonCode | null>(null);
  const [quantityInput, setQuantityInput] = useState('');
  const [notes, setNotes] = useState('');

  // ── Balance display (read-only) ─────────────────────────────────────────
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [locationId, setLocationId] = useState<string | null>(locationIdParam ?? null);

  // ── Validation errors ───────────────────────────────────────────────────
  const [reasonError, setReasonError] = useState('');
  const [quantityError, setQuantityError] = useState('');
  const [notesError, setNotesError] = useState('');

  // ── Submission state ────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [view, setView] = useState<ScreenView>('form');
  const [appliedDelta, setAppliedDelta] = useState(0);

  const notesRef = useRef<TextInput>(null);

  // ── Reset form when navigating to a different product ───────────────────
  useEffect(() => {
    setView('form');
    setReasonCode(null);
    setQuantityInput('');
    setNotes('');
    setReasonError('');
    setQuantityError('');
    setNotesError('');
    setSubmitting(false);
    setAppliedDelta(0);
  }, [skuId]);

  // ── Load current balance ────────────────────────────────────────────────
  useEffect(() => {
    if (!skuId || !businessId) return;
    setBalanceLoading(true);

    const query = supabase
      .from('inventory_balances')
      .select('quantity, location_id')
      .eq('sku_id', skuId)
      .eq('business_id', businessId);

    if (locationIdParam) {
      query.eq('location_id', locationIdParam);
    }

    query.maybeSingle().then(({ data }) => {
      if (data) {
        setCurrentBalance(Number(data.quantity));
        if (!locationIdParam && data.location_id) {
          setLocationId(data.location_id);
        }
      } else {
        setCurrentBalance(0);
      }
      setBalanceLoading(false);
    });
  }, [skuId, businessId, locationIdParam]);

  // ── Clear notes error when user types ──────────────────────────────────
  useEffect(() => {
    if (notes.trim()) setNotesError('');
  }, [notes]);

  // ── Validate form ───────────────────────────────────────────────────────
  const validate = useCallback((): boolean => {
    let valid = true;

    if (!reasonCode) {
      setReasonError('Please select a reason code.');
      valid = false;
    } else {
      setReasonError('');
    }

    const parsed = parseInt(quantityInput, 10);
    if (!quantityInput.trim() || isNaN(parsed) || parsed === 0) {
      setQuantityError('Enter a non-zero quantity (positive to add, negative to remove).');
      valid = false;
    } else {
      setQuantityError('');
    }

    // Requirement 5.2 — notes required when reason_code = 'other'
    if (reasonCode === 'other' && !notes.trim()) {
      setNotesError('Notes are required when the reason is "Other".');
      valid = false;
    } else {
      setNotesError('');
    }

    return valid;
  }, [reasonCode, quantityInput, notes]);

  // ── Submit ──────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!validate()) return;
    if (!skuId || !businessId) return;

    const delta = parseInt(quantityInput, 10);
    const idempotencyKey = generateIdempotencyKey();

    // Resolve location_id — required by the adjust-stock Edge Function.
    // Try current state first; fall back to querying the first active location.
    let resolvedLocationId = locationId;
    if (!resolvedLocationId) {
      const { data: locData } = await supabase
        .from('locations')
        .select('location_id')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      resolvedLocationId = locData?.location_id ?? null;
    }

    if (!resolvedLocationId) {
      Alert.alert('Configuration error', 'No active location found for your business.');
      return;
    }

    // Check connectivity before attempting network call (Requirement 13.2)
    const isOnline = await checkConnectivity();

    if (!isOnline) {
      // Enqueue for later sync when back online (Requirements 13.1, 13.2)
      enqueue({
        id: idempotencyKey,
        type: 'adjustment',
        payload: {
          sku_id: skuId,
          location_id: resolvedLocationId,
          quantity_delta: delta,
          reason_code: reasonCode,
          notes: notes.trim() || null,
        },
        createdAt: new Date().toISOString(),
        retryCount: 0,
        status: 'pending',
      });
      setAppliedDelta(delta);
      setView('pending_sync');
      return;
    }

    setSubmitting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        Alert.alert('Authentication error', 'You must be signed in to adjust stock.');
        return;
      }

      const body: Record<string, unknown> = {
        sku_id: skuId,
        quantity_delta: delta,
        reason_code: reasonCode,
        idempotency_key: idempotencyKey,
        location_id: resolvedLocationId,
      };

      if (notes.trim()) body.notes = notes.trim();

      const response = await fetch(`${SUPABASE_URL}/functions/v1/adjust-stock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error ?? 'Failed to submit adjustment.');
      }

      setAppliedDelta(delta);

      if (json.status === 'pending_approval') {
        setView('pending_approval');
      } else {
        // status = 'applied' — invalidate inventory caches so lists reflect the change
        queryClient.invalidateQueries({ queryKey: ['stock-on-hand'] });
        queryClient.invalidateQueries({ queryKey: ['report-stock-on-hand'] });
        queryClient.invalidateQueries({ queryKey: ['balance', skuId] });
        queryClient.invalidateQueries({ queryKey: ['movements', skuId] });
        setView('success');
      }
    } catch (err) {
      Alert.alert(
        'Adjustment failed',
        err instanceof Error ? err.message : 'An unexpected error occurred.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [validate, skuId, businessId, quantityInput, reasonCode, notes, locationId, enqueue, queryClient]);

  // ── Back navigation ─────────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(`/(app)/inventory/${skuId}`);
    }
  }, [router, skuId]);

  // ── Render confirmation views ────────────────────────────────────────────
  if (view === 'pending_approval') {
    return <PendingApprovalView onBack={handleBack} />;
  }
  if (view === 'pending_sync') {
    return <PendingSyncView delta={appliedDelta} onBack={handleBack} />;
  }
  if (view === 'success') {
    return <SuccessView delta={appliedDelta} onBack={handleBack} />;
  }

  // ── Render form ──────────────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Back navigation */}
        <TouchableOpacity
          style={styles.backRow}
          onPress={handleBack}
          accessibilityRole="button"
          accessibilityLabel="Cancel and go back"
        >
          <Text style={styles.backChevron}>‹</Text>
          <Text style={styles.backText}>Cancel</Text>
        </TouchableOpacity>

        {/* Screen title */}
        <View style={styles.titleSection}>
          <Text style={styles.screenTitle}>Adjust Stock</Text>
          {product ? (
            <>
              <Text style={styles.screenSubtitle} numberOfLines={1}>
                {product.name}
              </Text>
              <Text style={styles.screenSubtitle} numberOfLines={1}>
                SKU: {product.sku}
              </Text>
            </>
          ) : skuId ? (
            <Text style={styles.screenSubtitle} numberOfLines={1}>
              Loading…
            </Text>
          ) : null}
        </View>

        {/* Current balance */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Current Balance</Text>
          <View style={styles.balanceCard}>
            {balanceLoading ? (
              <ActivityIndicator color="#6366f1" />
            ) : (
              <Text style={styles.balanceValue}>
                {currentBalance ?? 0}
                <Text style={styles.balanceUnit}> units</Text>
              </Text>
            )}
          </View>
        </View>

        {/* Reason code — Requirement 5.1 */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Reason Code</Text>
          <ReasonPicker value={reasonCode} onChange={setReasonCode} />
          {reasonError ? (
            <Text style={styles.errorText} accessibilityRole="alert">
              {reasonError}
            </Text>
          ) : null}
        </View>

        {/* Quantity delta */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Quantity Adjustment</Text>
          <Text style={styles.fieldHint}>
            Enter a positive number to add stock, negative to remove (e.g. +5 or -3).
          </Text>
          <TextInput
            style={[styles.textInput, quantityError ? styles.textInputError : null]}
            value={quantityInput}
            onChangeText={(v) => {
              setQuantityInput(v);
              if (v.trim()) setQuantityError('');
            }}
            keyboardType="numbers-and-punctuation"
            placeholder="e.g. -5 or +10"
            placeholderTextColor="#9ca3af"
            returnKeyType="next"
            onSubmitEditing={() => notesRef.current?.focus()}
            accessibilityLabel="Quantity adjustment"
            accessibilityHint="Positive to add, negative to remove"
          />
          {quantityError ? (
            <Text style={styles.errorText} accessibilityRole="alert">
              {quantityError}
            </Text>
          ) : null}
        </View>

        {/* Notes — Requirement 5.2 */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            Notes{reasonCode === 'other' ? ' (required)' : ' (optional)'}
          </Text>
          <TextInput
            ref={notesRef}
            style={[
              styles.textInput,
              styles.textInputMultiline,
              notesError ? styles.textInputError : null,
            ]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Describe the reason for this adjustment…"
            placeholderTextColor="#9ca3af"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            accessibilityLabel="Adjustment notes"
            accessibilityHint={
              reasonCode === 'other'
                ? 'Required when reason is Other'
                : 'Optional description'
            }
          />
          {/* Inline validation message for 'other' + empty notes — Requirement 5.2 */}
          {notesError ? (
            <Text style={styles.errorText} accessibilityRole="alert">
              {notesError}
            </Text>
          ) : null}
        </View>

        {/* Submit */}
        <View style={styles.submitSection}>
          <TouchableOpacity
            style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Submit stock adjustment"
          >
            {submitting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.submitButtonText}>Submit Adjustment</Text>
            )}
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
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  scrollContent: {
    paddingBottom: 40,
  },
  // Back row
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 8,
    backgroundColor: '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  backChevron: {
    fontSize: 28,
    color: '#6366f1',
    lineHeight: 32,
    marginRight: 4,
  },
  backText: {
    fontSize: 16,
    color: '#6366f1',
    fontWeight: '500',
  },
  // Title
  titleSection: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  screenTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 2,
  },
  screenSubtitle: {
    fontSize: 13,
    color: '#6b7280',
  },
  // Sections
  section: {
    marginTop: 20,
    paddingHorizontal: 16,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 10,
  },
  // Balance card
  balanceCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  balanceValue: {
    fontSize: 48,
    fontWeight: '800',
    color: '#111827',
    lineHeight: 56,
  },
  balanceUnit: {
    fontSize: 16,
    fontWeight: '400',
    color: '#6b7280',
  },
  // Field hint
  fieldHint: {
    fontSize: 13,
    color: '#6b7280',
    marginBottom: 8,
    lineHeight: 18,
  },
  // Text inputs
  textInput: {
    borderWidth: 1.5,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  textInputMultiline: {
    minHeight: 90,
    paddingTop: 12,
  },
  textInputError: {
    borderColor: '#dc2626',
  },
  // Validation error
  errorText: {
    marginTop: 6,
    fontSize: 13,
    color: '#dc2626',
    fontWeight: '500',
  },
  // Submit
  submitSection: {
    marginTop: 28,
    paddingHorizontal: 16,
  },
  submitButton: {
    backgroundColor: '#111827',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  bottomPadding: {
    height: 40,
  },
});
