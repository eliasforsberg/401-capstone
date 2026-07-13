/**
 * Barcode scanner screen — full-screen camera with overlay, manual lookup fallback.
 *
 * Flow:
 *   1. Request camera permission on mount; show permission UI if denied.
 *   2. Render full-screen CameraView with a centre-box targeting overlay.
 *   3. On scan: debounce, call resolveBarcode(), navigate to product detail
 *      OR prompt user to create a new product.
 *   4. "Manual Search" toggle: text input + useProducts() search results list.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 15.2
 */

import { CameraView, Camera, type BarcodeScanningResult } from 'expo-camera';
import { router } from 'expo-router';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

import { resolveBarcode } from '@/lib/barcodeResolver';
import { useAuthStore } from '@/stores/authStore';
import { useProducts, type Product } from '@/hooks/useProducts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Supported barcode formats (expo-camera v16 / SDK 52 string identifiers). */
const BARCODE_TYPES: BarcodeScanningResult['type'][] = [
  'qr',
  'ean13',
  'ean8',
  'upc_a',
  'upc_e',
  'code128',
  'code39',
  'datamatrix',
] as BarcodeScanningResult['type'][];

/** Minimum ms between processing consecutive scans (debounce). */
const SCAN_DEBOUNCE_MS = 1500;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScanScreen() {
  const businessId = useAuthStore((s) => s.businessId);

  // ---- permission state ----
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  // ---- scan state ----
  const [scanning, setScanning] = useState(true);
  const [isResolving, setIsResolving] = useState(false);
  const lastScannedAt = useRef<number>(0);

  // ---- manual search state ----
  const [manualMode, setManualMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Debounced search value — only fire query after user stops typing.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: searchResults, isFetching: searchFetching } = useProducts({
    search: debouncedSearch,
    pageSize: 20,
  });

  // ---- request permission on mount ----
  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  // ---- debounce search input ----
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 400);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQuery]);

  // ---- resume scanning after delay ----
  const resumeScanning = useCallback((delayMs = SCAN_DEBOUNCE_MS) => {
    setTimeout(() => setScanning(true), delayMs);
  }, []);

  // ---- barcode scan handler ----
  const handleBarcodeScanned = useCallback(
    async ({ data: barcode }: BarcodeScanningResult) => {
      // Prevent concurrent or rapid re-processing.
      const now = Date.now();
      if (!scanning || isResolving || now - lastScannedAt.current < SCAN_DEBOUNCE_MS) {
        return;
      }
      lastScannedAt.current = now;
      setScanning(false);
      setIsResolving(true);

      if (!businessId) {
        Alert.alert('Error', 'Not authenticated. Please sign in again.');
        setIsResolving(false);
        resumeScanning();
        return;
      }

      try {
        const product = await resolveBarcode(barcode, businessId);

        if (product) {
          // Navigate to product detail screen.
          router.push({
            pathname: '/(app)/inventory/[skuId]',
            params: { skuId: product.productId, name: product.name },
          });
        } else {
          // Product not found — prompt to create new.
          Alert.alert(
            'Product Not Found',
            `No product matched barcode "${barcode}". Would you like to create one?`,
            [
              {
                text: 'Cancel',
                style: 'cancel',
                onPress: () => resumeScanning(),
              },
              {
                text: 'Create New',
                onPress: () => {
                  router.push({
                    pathname: '/(app)/inventory/new',
                    params: { barcode },
                  });
                },
              },
            ],
          );
        }
      } catch (err) {
        console.error('[ScanScreen] resolveBarcode error:', err);
        Alert.alert(
          'Lookup Failed',
          'Could not look up the barcode. Check your connection and try again.',
          [{ text: 'OK', onPress: () => resumeScanning() }],
        );
      } finally {
        setIsResolving(false);
      }
    },
    [scanning, isResolving, businessId, resumeScanning],
  );

  // ---- navigate to product from manual results ----
  const handleSelectProduct = useCallback((product: Product) => {
    router.push({
      pathname: '/(app)/inventory/[skuId]',
      params: { skuId: product.product_id, name: product.name },
    });
  }, []);

  // ---- toggle manual mode ----
  const toggleManualMode = () => {
    setManualMode((prev) => {
      if (!prev) setScanning(false); // pause camera while in manual mode
      else setScanning(true);
      return !prev;
    });
    setSearchQuery('');
    setDebouncedSearch('');
  };

  // ---- permission: not yet determined ----
  if (hasPermission === null) {
    return (
      <SafeAreaView style={styles.centeredContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.permissionText}>Requesting camera permission…</Text>
      </SafeAreaView>
    );
  }

  // ---- permission: denied ----
  if (hasPermission === false) {
    return (
      <SafeAreaView style={styles.centeredContainer}>
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionText}>
          This scanner needs camera access to scan barcodes. Please enable it in your
          device settings.
        </Text>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={async () => {
            const { status } = await Camera.requestCameraPermissionsAsync();
            setHasPermission(status === 'granted');
          }}
        >
          <Text style={styles.primaryButtonText}>Grant Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => router.back()}>
          <Text style={styles.secondaryButtonText}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ---- main scanner UI ----
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* Full-screen camera */}
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        onBarcodeScanned={scanning && !manualMode ? handleBarcodeScanned : undefined}
        barcodeScannerSettings={{
          barcodeTypes: BARCODE_TYPES,
        }}
      />

      {/* Dark overlay with cut-out effect using flex layout */}
      <View style={styles.overlay} pointerEvents="none">
        {/* Top dim strip */}
        <View style={styles.overlayTop} />
        {/* Middle row: side strips + clear target box */}
        <View style={styles.overlayMiddleRow}>
          <View style={styles.overlaySide} />
          {/* Targeting box — transparent centre window */}
          <View style={styles.targetBox}>
            {/* Corner markers */}
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <View style={styles.overlaySide} />
        </View>
        {/* Bottom dim strip — takes all remaining space */}
        <View style={styles.overlayBottom} />
      </View>

      {/* Top bar: back button */}
      <SafeAreaView style={styles.topBar} pointerEvents="box-none">
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>✕</Text>
        </TouchableOpacity>
        <Text style={styles.screenTitle}>Scan Barcode</Text>
        <View style={styles.backButtonPlaceholder} />
      </SafeAreaView>

      {/* Resolving spinner */}
      {isResolving && (
        <View style={styles.resolvingOverlay}>
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text style={styles.resolvingText}>Looking up product…</Text>
        </View>
      )}

      {/* Hint text (only when not in manual mode and not resolving) */}
      {!manualMode && !isResolving && (
        <View style={styles.hintContainer} pointerEvents="none">
          <Text style={styles.hintText}>
            Point the camera at a barcode to scan
          </Text>
        </View>
      )}

      {/* Bottom controls */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.bottomControls}
      >
        {/* Manual search panel */}
        {manualMode && (
          <View style={styles.manualPanel}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search by name, SKU, or barcode…"
              placeholderTextColor="#9CA3AF"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
              returnKeyType="search"
              clearButtonMode="while-editing"
              accessibilityLabel="Product search"
              accessibilityHint="Type a product name, SKU, or partial barcode to search"
            />

            {searchFetching && debouncedSearch.length > 0 && (
              <ActivityIndicator
                size="small"
                color="#007AFF"
                style={styles.searchSpinner}
              />
            )}

            {!searchFetching &&
              debouncedSearch.length > 0 &&
              searchResults?.products.length === 0 && (
                <View style={styles.emptyResults}>
                  <Text style={styles.emptyResultsText}>No products found.</Text>
                  <TouchableOpacity
                    style={styles.createButton}
                    onPress={() =>
                      router.push({
                        pathname: '/(app)/inventory/new',
                        params: { barcode: debouncedSearch },
                      })
                    }
                  >
                    <Text style={styles.createButtonText}>+ Create New Product</Text>
                  </TouchableOpacity>
                </View>
              )}

            {(searchResults?.products ?? []).length > 0 && (
              <FlatList
                style={styles.resultsList}
                data={searchResults?.products ?? []}
                keyExtractor={(item) => item.product_id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.resultItem}
                    onPress={() => handleSelectProduct(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${item.name}`}
                  >
                    <Text style={styles.resultName}>{item.name}</Text>
                    <Text style={styles.resultSku}>SKU: {item.sku}</Text>
                  </TouchableOpacity>
                )}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              />
            )}
          </View>
        )}

        {/* Toggle button */}
        <TouchableOpacity
          style={manualMode ? styles.toggleButtonActive : styles.toggleButton}
          onPress={toggleManualMode}
          accessibilityRole="button"
          accessibilityLabel={manualMode ? 'Switch to camera scan' : 'Manual search'}
        >
          <Text
            style={
              manualMode ? styles.toggleButtonActiveText : styles.toggleButtonText
            }
          >
            {manualMode ? '📷  Use Camera' : '🔍  Manual Search'}
          </Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const TARGET_BOX_SIZE = 260;
const CORNER_SIZE = 24;
const CORNER_WIDTH = 3;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  centeredContainer: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },

  // ---- permission screens ----
  permissionTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
  },
  permissionText: {
    fontSize: 15,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 22,
    marginTop: 8,
  },
  primaryButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    marginTop: 8,
  },
  primaryButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  secondaryButtonText: {
    color: '#6B7280',
    fontSize: 15,
  },

  // ---- camera overlay (flex column: top | middle-row | bottom) ----
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'column',
  },
  overlayTop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  overlayMiddleRow: {
    height: TARGET_BOX_SIZE,
    flexDirection: 'row',
  },
  overlaySide: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  targetBox: {
    width: TARGET_BOX_SIZE,
    height: TARGET_BOX_SIZE,
    position: 'relative',
  },
  overlayBottom: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },

  // Corner marker helpers
  corner: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderColor: '#FFFFFF',
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderTopLeftRadius: 4,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderTopRightRadius: 4,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderBottomLeftRadius: 4,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderBottomRightRadius: 4,
  },

  // ---- top bar ----
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButtonText: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '600',
  },
  backButtonPlaceholder: {
    width: 40,
  },
  screenTitle: {
    color: '#FFF',
    fontSize: 17,
    fontWeight: '600',
  },

  // ---- resolving overlay ----
  resolvingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  resolvingText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '500',
  },

  // ---- hint text ----
  hintContainer: {
    position: 'absolute',
    bottom: 180,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  hintText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 14,
    fontWeight: '400',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    overflow: 'hidden',
  },

  // ---- bottom controls ----
  bottomControls: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
  },

  // ---- manual search panel ----
  manualPanel: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 16,
    padding: 12,
    maxHeight: 360,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 8,
  },
  searchInput: {
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: 15,
    color: '#111827',
  },
  searchSpinner: {
    marginTop: 12,
  },
  emptyResults: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 10,
  },
  emptyResultsText: {
    color: '#6B7280',
    fontSize: 14,
  },
  createButton: {
    backgroundColor: '#EFF6FF',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
  },
  createButtonText: {
    color: '#2563EB',
    fontWeight: '600',
    fontSize: 14,
  },
  resultsList: {
    marginTop: 8,
    maxHeight: 260,
  },
  resultItem: {
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  resultName: {
    fontSize: 15,
    fontWeight: '500',
    color: '#111827',
  },
  resultSku: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },

  // ---- toggle button ----
  toggleButton: {
    marginHorizontal: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  toggleButtonText: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '600',
  },
  toggleButtonActive: {
    marginHorizontal: 16,
    backgroundColor: '#FFFFFF',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  toggleButtonActiveText: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '600',
  },
});
