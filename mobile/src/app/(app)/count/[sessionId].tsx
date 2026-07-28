/**
 * Count session screen — scan SKUs, enter counted quantities, submit per line.
 *
 * Requirements: 6.2, 6.3, 6.4, 6.8, 6.9
 *
 * Key behaviours:
 *  - Shows product NAME only until submission (req 6.3 — no system balance shown)
 *  - Variance calculated as counted − snapshot; displayed for confirmation
 *  - Offline: queues submit-count-line calls in MMKV; processes on reconnect
 *  - "Complete Session" available when all lines submitted
 *  - "Cancel Session" warns user before calling cancel-count-session
 */

import { CameraView, Camera, type BarcodeScanningResult, type BarcodeType } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { resolveBarcode } from '@/lib/barcodeResolver';
import { generateIdempotencyKey } from '@/lib/idempotency';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import { useOfflineQueueStore } from '@/stores/offlineQueueStore';
import type { CountSessionStatus, CountType } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CountLine {
  line_id: string;
  sku_id: string;
  product_name: string;
  snapshot_quantity: number;
  submitted_quantity: number | null; // null = not yet submitted
  variance: number | null;
}

interface CountSession {
  session_id: string;
  count_type: CountType;
  started_at: string;
  status: CountSessionStatus;
}

interface SessionSummary {
  total_skus: number;
  variance_units: number;
  variance_value: number;
  positive_variance_count: number;
  negative_variance_count: number;
}

/** State for the active scan / entry panel. */
interface ActiveEntry {
  line: CountLine;
  countedQtyInput: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatVariance(v: number): string {
  return v > 0 ? `+${v}` : String(v);
}

async function checkConnectivity(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch('https://www.google.com', {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/** Barcode scanning formats accepted. */
const BARCODE_TYPES: BarcodeType[] = [
  'qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'datamatrix',
];

const SCAN_DEBOUNCE_MS = 1500;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Compact row for a submitted or uncounted line in the list. */
function LineRow({
  line,
  onSelect,
}: {
  line: CountLine;
  onSelect: () => void;
}) {
  const isSubmitted = line.submitted_quantity != null;
  return (
    <TouchableOpacity
      style={[rowStyles.card, isSubmitted && rowStyles.cardSubmitted]}
      onPress={isSubmitted ? undefined : onSelect}
      activeOpacity={isSubmitted ? 1 : 0.7}
    >
      <View style={rowStyles.left}>
        <Text style={rowStyles.name} numberOfLines={1}>
          {line.product_name}
        </Text>
        {isSubmitted ? (
          <View style={rowStyles.varRow}>
            <Text style={rowStyles.countedLabel}>
              Counted: {line.submitted_quantity}
            </Text>
            {line.variance !== null && (
              <Text
                style={[
                  rowStyles.variance,
                  line.variance > 0
                    ? rowStyles.variancePos
                    : line.variance < 0
                    ? rowStyles.varianceNeg
                    : rowStyles.varianceZero,
                ]}
              >
                {formatVariance(line.variance)}
              </Text>
            )}
          </View>
        ) : (
          <Text style={rowStyles.pendingLabel}>Tap to count</Text>
        )}
      </View>
      {isSubmitted ? (
        <View style={rowStyles.checkBadge}>
          <Text style={rowStyles.checkText}>✓</Text>
        </View>
      ) : (
        <Text style={rowStyles.chevron}>›</Text>
      )}
    </TouchableOpacity>
  );
}

const rowStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  cardSubmitted: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#BBF7D0',
  },
  left: { flex: 1, marginRight: 10 },
  name: { fontSize: 15, fontWeight: '600', color: '#111827', marginBottom: 3 },
  pendingLabel: { fontSize: 12, color: '#9CA3AF' },
  varRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  countedLabel: { fontSize: 12, color: '#374151' },
  variance: { fontSize: 12, fontWeight: '700' },
  variancePos: { color: '#16A34A' },
  varianceNeg: { color: '#DC2626' },
  varianceZero: { color: '#6B7280' },
  checkBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#22C55E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  chevron: { fontSize: 20, color: '#9CA3AF' },
});

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function CountSessionScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const businessId = useAuthStore((s) => s.businessId);
  const enqueue = useOfflineQueueStore((s) => s.enqueue);

  // ---- session & lines state ----
  const [session, setSession] = useState<CountSession | null>(null);
  const [lines, setLines] = useState<CountLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- active entry (selected line for counting) ----
  const [activeEntry, setActiveEntry] = useState<ActiveEntry | null>(null);

  // ---- scanner state ----
  const [scanMode, setScanMode] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [scanning, setScanning] = useState(true);
  const lastScannedAt = useRef<number>(0);

  // ---- submission ----
  const [submittingLineId, setSubmittingLineId] = useState<string | null>(null);

  // ---- session summary modal ----
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [summary, setSummary] = useState<SessionSummary | null>(null);

  // ---- variance confirm modal ----
  const [pendingVariance, setPendingVariance] = useState<{
    line: CountLine;
    counted: number;
    variance: number;
  } | null>(null);

  // ---- camera permission request ----
  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchSessionData = useCallback(async () => {
    if (!sessionId || !businessId) return;
    setError(null);

    // Fetch session header
    const { data: sessionData, error: sessionErr } = await supabase
      .from('stock_count_sessions')
      .select('session_id, count_type, started_at, status')
      .eq('session_id', sessionId)
      .eq('business_id', businessId)
      .single();

    if (sessionErr || !sessionData) {
      setError('Count session not found.');
      return;
    }
    setSession(sessionData as CountSession);

    // Fetch lines joined to products for name
    const { data: linesData, error: linesErr } = await supabase
      .from('stock_count_lines')
      .select(
        `
        line_id,
        sku_id,
        snapshot_quantity,
        submitted_quantity,
        variance,
        products ( name )
        `
      )
      .eq('session_id', sessionId)
      .eq('business_id', businessId)
      .order('created_at', { ascending: true });

    if (linesErr) {
      setError('Failed to load count lines.');
      return;
    }

    const mapped: CountLine[] = (linesData ?? []).map((row: any) => ({
      line_id: row.line_id,
      sku_id: row.sku_id,
      product_name: row.products?.name ?? 'Unknown Product',
      snapshot_quantity: Number(row.snapshot_quantity ?? 0),
      submitted_quantity: row.submitted_quantity != null ? Number(row.submitted_quantity) : null,
      variance: row.variance != null ? Number(row.variance) : null,
    }));

    setLines(mapped);
  }, [sessionId, businessId]);

  useEffect(() => {
    setLoading(true);
    fetchSessionData().finally(() => setLoading(false));
  }, [fetchSessionData]);

  // ---------------------------------------------------------------------------
  // Barcode scan handler
  // ---------------------------------------------------------------------------

  const handleBarcodeScanned = useCallback(
    async ({ data: barcode }: BarcodeScanningResult) => {
      const now = Date.now();
      if (!scanning || isResolving || now - lastScannedAt.current < SCAN_DEBOUNCE_MS) return;
      lastScannedAt.current = now;
      setScanning(false);
      setIsResolving(true);

      try {
        const product = await resolveBarcode(barcode, businessId!);
        if (!product) {
          Alert.alert('Not Found', `No product matched barcode "${barcode}".`, [
            { text: 'OK', onPress: () => { setScanning(true); setIsResolving(false); } },
          ]);
          return;
        }

        // Find the matching line in this session
        const matchedLine = lines.find((l) => l.sku_id === product.productId);
        if (!matchedLine) {
          Alert.alert('Not in Scope', `"${product.name}" is not part of this count session.`, [
            { text: 'OK', onPress: () => { setScanning(true); setIsResolving(false); } },
          ]);
          return;
        }

        if (matchedLine.submitted_quantity != null) {
          Alert.alert('Already Counted', `"${product.name}" has already been submitted.`, [
            { text: 'OK', onPress: () => { setScanning(true); setIsResolving(false); } },
          ]);
          return;
        }

        // Open entry panel for this line (no system balance shown per req 6.3)
        setScanMode(false);
        setActiveEntry({ line: matchedLine, countedQtyInput: '' });
        setScanning(true);
      } catch {
        Alert.alert('Lookup Failed', 'Could not resolve barcode. Check connection.', [
          { text: 'OK', onPress: () => { setScanning(true); setIsResolving(false); } },
        ]);
      } finally {
        setIsResolving(false);
      }
    },
    [scanning, isResolving, businessId, lines]
  );

  // ---------------------------------------------------------------------------
  // Submit count line
  // ---------------------------------------------------------------------------

  const handleSubmitLine = useCallback(async () => {
    if (!activeEntry) return;

    const counted = parseFloat(activeEntry.countedQtyInput);
    if (isNaN(counted) || counted < 0) {
      Alert.alert('Invalid', 'Please enter a valid counted quantity (0 or more).');
      return;
    }

    const variance = counted - activeEntry.line.snapshot_quantity;
    // Show variance confirmation (req 6.4)
    setPendingVariance({ line: activeEntry.line, counted, variance });
  }, [activeEntry]);

  const confirmSubmit = useCallback(async () => {
    if (!pendingVariance || !sessionId || !businessId) return;

    const { line, counted } = pendingVariance;
    setPendingVariance(null);
    setSubmittingLineId(line.line_id);

    const idempotencyKey = generateIdempotencyKey();
    const isOnline = await checkConnectivity();

    if (!isOnline) {
      // Queue offline (req 6.9)
      enqueue({
        id: idempotencyKey,
        type: 'count_line',
        payload: {
          session_id: sessionId,
          sku_id: line.sku_id,
          counted_quantity: counted,
        },
        createdAt: new Date().toISOString(),
        retryCount: 0,
        status: 'pending',
      });

      // Optimistically update local state
      setLines((prev) =>
        prev.map((l) =>
          l.line_id === line.line_id
            ? { ...l, submitted_quantity: counted, variance: counted - l.snapshot_quantity }
            : l
        )
      );
      setActiveEntry(null);
      setSubmittingLineId(null);

      Alert.alert(
        'Offline',
        'Count queued. It will sync automatically when you reconnect.'
      );
      return;
    }

    try {
      const { error: fnErr } = await supabase.functions.invoke('submit-count-line', {
        body: {
          session_id: sessionId,
          sku_id: line.sku_id,
          counted_quantity: counted,
          idempotency_key: idempotencyKey,
        },
      });

      if (fnErr) throw new Error(fnErr.message ?? 'Submit failed');

      // Refresh lines from server to pick up server-computed variance
      await fetchSessionData();
      setActiveEntry(null);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not submit count.');
    } finally {
      setSubmittingLineId(null);
    }
  }, [pendingVariance, sessionId, businessId, enqueue, fetchSessionData]);

  // ---------------------------------------------------------------------------
  // Complete session
  // ---------------------------------------------------------------------------

  const handleCompleteSession = useCallback(async () => {
    if (!sessionId) return;
    const isOnline = await checkConnectivity();
    if (!isOnline) {
      Alert.alert('Offline', 'Please reconnect to complete the session.');
      return;
    }

    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        'complete-count-session',
        { body: { session_id: sessionId } }
      );

      if (fnErr) throw new Error(fnErr.message ?? 'Could not complete session');

      const summaryData: SessionSummary = {
        total_skus: data?.total_skus ?? lines.length,
        variance_units: data?.variance_units ?? 0,
        variance_value: data?.variance_value ?? 0,
        positive_variance_count: data?.positive_variance_count ?? 0,
        negative_variance_count: data?.negative_variance_count ?? 0,
      };
      setSummary(summaryData);
      setSummaryVisible(true);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not complete session.');
    }
  }, [sessionId, lines]);

  // ---------------------------------------------------------------------------
  // Cancel session
  // ---------------------------------------------------------------------------

  const handleCancelSession = useCallback(() => {
    Alert.alert(
      'Cancel Count Session?',
      'All submitted counts will be reversed and the session will be discarded. This cannot be undone.',
      [
        { text: 'Keep Counting', style: 'cancel' },
        {
          text: 'Cancel Session',
          style: 'destructive',
          onPress: async () => {
            try {
              const { error: fnErr } = await supabase.functions.invoke(
                'cancel-count-session',
                { body: { session_id: sessionId } }
              );
              if (fnErr) throw new Error(fnErr.message);
              router.replace('/(app)/count');
            } catch (err: unknown) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Could not cancel session.');
            }
          },
        },
      ]
    );
  }, [sessionId]);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const submittedCount = lines.filter((l) => l.submitted_quantity != null).length;
  const totalCount = lines.length;
  const allSubmitted = totalCount > 0 && submittedCount === totalCount;
  const progressPct = totalCount > 0 ? submittedCount / totalCount : 0;

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  if (error || !session) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? 'Session not found.'}</Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — scanner overlay
  // ---------------------------------------------------------------------------

  if (scanMode) {
    if (hasPermission === false) {
      return (
        <View style={styles.centered}>
          <Text style={styles.errorText}>Camera permission is required to scan barcodes.</Text>
          <TouchableOpacity style={styles.backBtn} onPress={() => setScanMode(false)}>
            <Text style={styles.backBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={styles.scanRoot}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          onBarcodeScanned={scanning && !isResolving ? handleBarcodeScanned : undefined}
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
        />
        {/* dim overlay */}
        <View style={styles.scanOverlayTop} pointerEvents="none" />
        <View style={styles.scanMiddleRow} pointerEvents="none">
          <View style={styles.scanSide} />
          <View style={styles.scanTarget}>
            <View style={[styles.scanCorner, styles.scanCornerTL]} />
            <View style={[styles.scanCorner, styles.scanCornerTR]} />
            <View style={[styles.scanCorner, styles.scanCornerBL]} />
            <View style={[styles.scanCorner, styles.scanCornerBR]} />
          </View>
          <View style={styles.scanSide} />
        </View>
        <View style={styles.scanOverlayBottom} pointerEvents="none" />

        {isResolving && (
          <View style={styles.resolvingOverlay}>
            <ActivityIndicator size="large" color="#FFFFFF" />
            <Text style={styles.resolvingText}>Looking up product…</Text>
          </View>
        )}

        <View style={styles.scanTopBar}>
          <TouchableOpacity style={styles.scanCloseBtn} onPress={() => setScanMode(false)}>
            <Text style={styles.scanCloseBtnText}>✕</Text>
          </TouchableOpacity>
          <Text style={styles.scanTitle}>Scan SKU Barcode</Text>
          <View style={styles.scanCloseBtnPlaceholder} />
        </View>

        <View style={styles.scanHint} pointerEvents="none">
          <Text style={styles.scanHintText}>Point at a product barcode</Text>
        </View>
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — main session UI
  // ---------------------------------------------------------------------------

  const pendingLines = lines.filter((l) => l.submitted_quantity == null);
  const submittedLines = lines.filter((l) => l.submitted_quantity != null);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backRow} onPress={() => router.back()}>
          <Text style={styles.backArrow}>‹</Text>
          <Text style={styles.backLabel}>Count</Text>
        </TouchableOpacity>
        <Text style={styles.sessionTitle}>
          {session.count_type === 'cycle_count' ? 'Cycle Count' : 'Full Audit'}
        </Text>
        <View style={styles.progressRow}>
          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${progressPct * 100}%` }]} />
          </View>
          <Text style={styles.progressText}>
            {submittedCount} / {totalCount} counted
          </Text>
        </View>
      </View>

      {/* Active entry panel */}
      {activeEntry && (
        <View style={styles.entryPanel}>
          <View style={styles.entryHeader}>
            <Text style={styles.entryTitle} numberOfLines={2}>
              {activeEntry.line.product_name}
            </Text>
            {/* NOTE: system balance is intentionally NOT shown here (req 6.3) */}
            <TouchableOpacity onPress={() => setActiveEntry(null)} style={styles.entryCloseBtn}>
              <Text style={styles.entryCloseBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.entryInstruction}>Enter the physical count:</Text>
          <TextInput
            style={styles.entryInput}
            value={activeEntry.countedQtyInput}
            onChangeText={(v) =>
              setActiveEntry((prev) => prev ? { ...prev, countedQtyInput: v } : null)
            }
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor="#9CA3AF"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={handleSubmitLine}
          />
          <TouchableOpacity
            style={[
              styles.submitLineBtn,
              submittingLineId === activeEntry.line.line_id && styles.submitLineBtnDisabled,
            ]}
            onPress={handleSubmitLine}
            disabled={submittingLineId === activeEntry.line.line_id}
            activeOpacity={0.8}
          >
            {submittingLineId === activeEntry.line.line_id ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.submitLineBtnText}>Submit Count</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Lines list */}
      <FlatList
        data={[...pendingLines, ...submittedLines]}
        keyExtractor={(item) => item.line_id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <LineRow
            line={item}
            onSelect={() => setActiveEntry({ line: item, countedQtyInput: '' })}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No lines in this session.</Text>
          </View>
        }
      />

      {/* Footer actions */}
      <View style={styles.footer}>
        {!activeEntry && !allSubmitted && (
          <TouchableOpacity
            style={styles.scanButton}
            onPress={() => setScanMode(true)}
            activeOpacity={0.8}
          >
            <Text style={styles.scanButtonText}>📷  Scan Barcode</Text>
          </TouchableOpacity>
        )}
        {allSubmitted && (
          <TouchableOpacity
            style={styles.completeButton}
            onPress={handleCompleteSession}
            activeOpacity={0.8}
          >
            <Text style={styles.completeButtonText}>Complete Session</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={handleCancelSession}
          activeOpacity={0.7}
        >
          <Text style={styles.cancelButtonText}>Cancel Session</Text>
        </TouchableOpacity>
      </View>

      {/* Variance confirmation modal (req 6.4) */}
      <Modal
        visible={pendingVariance !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPendingVariance(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirm Count</Text>
            {pendingVariance && (
              <>
                <Text style={styles.modalProductName} numberOfLines={2}>
                  {pendingVariance.line.product_name}
                </Text>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Counted</Text>
                  <Text style={styles.modalValue}>{pendingVariance.counted}</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Variance</Text>
                  <Text
                    style={[
                      styles.modalValue,
                      pendingVariance.variance > 0
                        ? styles.variancePos
                        : pendingVariance.variance < 0
                        ? styles.varianceNeg
                        : styles.varianceZero,
                    ]}
                  >
                    {formatVariance(pendingVariance.variance)} units
                  </Text>
                </View>
                {pendingVariance.variance !== 0 && (
                  <Text style={styles.modalNote}>
                    A count correction movement will be applied to adjust the
                    balance.
                  </Text>
                )}
              </>
            )}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setPendingVariance(null)}
              >
                <Text style={styles.modalCancelBtnText}>Recount</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalConfirmBtn}
                onPress={confirmSubmit}
              >
                <Text style={styles.modalConfirmBtnText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Session summary modal (req 6.7) */}
      <Modal
        visible={summaryVisible}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setSummaryVisible(false);
          router.replace('/(app)/count');
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryTitle}>Count Complete 🎉</Text>
            {summary && (
              <>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>SKUs counted</Text>
                  <Text style={styles.summaryValue}>{summary.total_skus}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Total variance (units)</Text>
                  <Text style={styles.summaryValue}>
                    {formatVariance(summary.variance_units)}
                  </Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Variance value</Text>
                  <Text style={styles.summaryValue}>
                    ${summary.variance_value.toFixed(2)}
                  </Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>SKUs over-counted</Text>
                  <Text style={[styles.summaryValue, styles.variancePos]}>
                    {summary.positive_variance_count}
                  </Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>SKUs under-counted</Text>
                  <Text style={[styles.summaryValue, styles.varianceNeg]}>
                    {summary.negative_variance_count}
                  </Text>
                </View>
              </>
            )}
            <TouchableOpacity
              style={styles.summaryDoneBtn}
              onPress={() => {
                setSummaryVisible(false);
                router.replace('/(app)/count');
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.summaryDoneBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const SCAN_TARGET_SIZE = 260;
const CORNER_SIZE = 24;
const CORNER_WIDTH = 3;

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
  backBtnText: { color: '#FFFFFF', fontWeight: '600' },

  // ---- header ----
  header: {
    backgroundColor: '#FFFFFF',
    paddingTop: 52,
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  backArrow: { fontSize: 24, color: '#6366F1', lineHeight: 28, marginRight: 2 },
  backLabel: { fontSize: 15, color: '#6366F1' },
  sessionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 10,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  progressBarBg: {
    flex: 1,
    height: 6,
    backgroundColor: '#E5E7EB',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#6366F1',
    borderRadius: 3,
  },
  progressText: { fontSize: 12, color: '#6B7280', minWidth: 80, textAlign: 'right' },

  // ---- active entry panel ----
  entryPanel: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 3,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  entryTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
    marginRight: 10,
  },
  entryCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  entryCloseBtnText: { fontSize: 14, color: '#374151', fontWeight: '600' },
  entryInstruction: { fontSize: 13, color: '#6B7280', marginBottom: 10 },
  entryInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
    backgroundColor: '#F9FAFB',
    marginBottom: 12,
  },
  submitLineBtn: {
    backgroundColor: '#6366F1',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  submitLineBtnDisabled: { backgroundColor: '#A5B4FC' },
  submitLineBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },

  // ---- list ----
  listContent: { padding: 12, paddingBottom: 20 },
  emptyState: { paddingVertical: 60, alignItems: 'center' },
  emptyText: { fontSize: 15, color: '#6B7280' },

  // ---- footer ----
  footer: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E7EB',
    gap: 10,
  },
  scanButton: {
    backgroundColor: '#6366F1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  scanButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  completeButton: {
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  completeButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  cancelButton: {
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#FFF1F2',
  },
  cancelButtonText: { color: '#DC2626', fontSize: 15, fontWeight: '500' },

  // ---- variance / summary modals ----
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
  },
  modalProductName: {
    fontSize: 15,
    color: '#374151',
    marginBottom: 16,
    lineHeight: 20,
  },
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F3F4F6',
  },
  modalLabel: { fontSize: 14, color: '#6B7280' },
  modalValue: { fontSize: 14, fontWeight: '700', color: '#111827' },
  modalNote: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 10,
    lineHeight: 16,
    fontStyle: 'italic',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  modalCancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCancelBtnText: { color: '#374151', fontWeight: '600', fontSize: 15 },
  modalConfirmBtn: {
    flex: 1,
    backgroundColor: '#6366F1',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalConfirmBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },

  // ---- summary modal ----
  summaryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  summaryTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 20,
    textAlign: 'center',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F3F4F6',
  },
  summaryLabel: { fontSize: 14, color: '#6B7280' },
  summaryValue: { fontSize: 14, fontWeight: '700', color: '#111827' },
  summaryDoneBtn: {
    backgroundColor: '#6366F1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  summaryDoneBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },

  // ---- variance colors ----
  variancePos: { color: '#16A34A' },
  varianceNeg: { color: '#DC2626' },
  varianceZero: { color: '#6B7280' },

  // ---- scanner overlay ----
  scanRoot: { flex: 1, backgroundColor: '#000' },
  scanOverlayTop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  scanMiddleRow: { height: SCAN_TARGET_SIZE, flexDirection: 'row' },
  scanSide: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  scanTarget: { width: SCAN_TARGET_SIZE, height: SCAN_TARGET_SIZE, position: 'relative' },
  scanOverlayBottom: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  scanCorner: { position: 'absolute', width: CORNER_SIZE, height: CORNER_SIZE, borderColor: '#FFFFFF' },
  scanCornerTL: { top: 0, left: 0, borderTopWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH, borderTopLeftRadius: 4 },
  scanCornerTR: { top: 0, right: 0, borderTopWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH, borderTopRightRadius: 4 },
  scanCornerBL: { bottom: 0, left: 0, borderBottomWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH, borderBottomLeftRadius: 4 },
  scanCornerBR: { bottom: 0, right: 0, borderBottomWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH, borderBottomRightRadius: 4 },
  resolvingOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', alignItems: 'center', gap: 12,
  },
  resolvingText: { color: '#FFF', fontSize: 16, fontWeight: '500' },
  scanTopBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 52, paddingBottom: 12,
  },
  scanCloseBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center', alignItems: 'center',
  },
  scanCloseBtnText: { color: '#FFF', fontSize: 18, fontWeight: '600' },
  scanCloseBtnPlaceholder: { width: 40 },
  scanTitle: { color: '#FFF', fontSize: 17, fontWeight: '600' },
  scanHint: {
    position: 'absolute', bottom: 120, left: 0, right: 0, alignItems: 'center',
  },
  scanHintText: {
    color: 'rgba(255,255,255,0.85)', fontSize: 14,
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 16, paddingVertical: 6, borderRadius: 20, overflow: 'hidden',
  },
});
