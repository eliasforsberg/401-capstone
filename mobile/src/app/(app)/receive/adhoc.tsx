import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';

// ---------------------------------------------------------------------------
// Ad Hoc Receive Screen
//
// Allows receiving stock without an associated purchase order.
// The user can scan a barcode (or enter it manually) to look up the product,
// then confirm a received quantity, optional damaged quantity, and unit cost.
//
// Full offline-queue integration and Edge Function call will be wired in
// task 15.2. This screen implements the UI shell and barcode scan capability.
// ---------------------------------------------------------------------------

export default function AdhocReceiveScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [barcode, setBarcode] = useState('');
  const [productName, setProductName] = useState('');
  const [receivedQty, setReceivedQty] = useState('');
  const [damagedQty, setDamagedQty] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [scanned, setScanned] = useState(false);

  // ---------------------------------------------------------------------------
  // Barcode scan handler
  // ---------------------------------------------------------------------------

  function handleBarCodeScanned({ data }: { data: string }) {
    setScanned(true);
    setScannerOpen(false);
    setBarcode(data);
    // Product resolution from the barcode catalog will be wired in task 15.2
    // via barcodeResolver.ts. For now we surface the raw barcode value.
    setProductName('');
  }

  async function openScanner() {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert(
          'Camera permission required',
          'Please allow camera access to scan barcodes.'
        );
        return;
      }
    }
    setScanned(false);
    setScannerOpen(true);
  }

  // ---------------------------------------------------------------------------
  // Form submit
  // ---------------------------------------------------------------------------

  function handleSubmit() {
    const qty = parseFloat(receivedQty);
    const dmgQty = parseFloat(damagedQty || '0') || 0;

    if (!barcode.trim()) {
      Alert.alert('Missing barcode', 'Please scan or enter a product barcode.');
      return;
    }
    if (isNaN(qty) || qty <= 0) {
      Alert.alert('Invalid quantity', 'Received quantity must be greater than 0.');
      return;
    }
    if (dmgQty < 0 || dmgQty > qty) {
      Alert.alert(
        'Invalid quantity',
        'Damaged quantity must be between 0 and the received quantity.'
      );
      return;
    }

    // Full submission (Edge Function + offline queue) will be wired in task 15.2.
    Alert.alert(
      'Ad Hoc Receive',
      `Ready to receive ${qty} unit(s) of barcode "${barcode}".\n\nFull submission will be enabled in task 15.2.`,
      [{ text: 'OK' }]
    );
  }

  // ---------------------------------------------------------------------------
  // Render — barcode scanner overlay
  // ---------------------------------------------------------------------------

  if (scannerOpen) {
    return (
      <View style={styles.scannerContainer}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{
            barcodeTypes: [
              'upc_a',
              'upc_e',
              'ean13',
              'ean8',
              'code128',
              'code39',
              'qr',
              'datamatrix',
            ] as BarcodeType[],
          }}
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
        />

        {/* Scan target overlay */}
        <View style={styles.scanOverlay}>
          <View style={styles.scanFrame} />
          <Text style={styles.scanHint}>Align barcode within the frame</Text>
        </View>

        {/* Cancel button */}
        <TouchableOpacity
          style={styles.cancelScanBtn}
          onPress={() => setScannerOpen(false)}
        >
          <Text style={styles.cancelScanText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — form
  // ---------------------------------------------------------------------------

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backTouchable}>
          <Text style={styles.backArrow}>‹</Text>
          <Text style={styles.backLabel}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Ad Hoc Receive</Text>
        <Text style={styles.subtitle}>Receive stock without a purchase order</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Barcode field */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Product</Text>

          <View style={styles.barcodeRow}>
            <TextInput
              style={[styles.input, styles.barcodeInput]}
              value={barcode}
              onChangeText={(v) => {
                setBarcode(v);
                setProductName('');
              }}
              placeholder="Enter or scan barcode"
              placeholderTextColor="#9CA3AF"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={styles.scanBtn}
              onPress={openScanner}
              activeOpacity={0.8}
            >
              <Text style={styles.scanBtnText}>Scan</Text>
            </TouchableOpacity>
          </View>

          {productName ? (
            <Text style={styles.productResolved}>✓ {productName}</Text>
          ) : barcode ? (
            <Text style={styles.productUnresolved}>
              Product lookup happens on submit (task 15.2)
            </Text>
          ) : null}
        </View>

        {/* Quantities */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quantities</Text>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Received qty *</Text>
            <TextInput
              style={styles.inputSmall}
              value={receivedQty}
              onChangeText={setReceivedQty}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor="#9CA3AF"
            />
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Damaged qty</Text>
            <TextInput
              style={styles.inputSmall}
              value={damagedQty}
              onChangeText={setDamagedQty}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor="#9CA3AF"
            />
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Unit cost ($)</Text>
            <TextInput
              style={styles.inputSmall}
              value={unitCost}
              onChangeText={setUnitCost}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor="#9CA3AF"
            />
          </View>
        </View>

        {/* Submit */}
        <TouchableOpacity
          style={styles.submitBtn}
          onPress={handleSubmit}
          activeOpacity={0.8}
        >
          <Text style={styles.submitBtnText}>Confirm Receive</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
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
  // ---- Scanner ----
  scannerContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanFrame: {
    width: 260,
    height: 160,
    borderWidth: 2,
    borderColor: '#6366F1',
    borderRadius: 12,
    marginBottom: 16,
  },
  scanHint: {
    color: '#FFFFFF',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  cancelScanBtn: {
    position: 'absolute',
    bottom: 48,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 24,
    paddingHorizontal: 28,
    paddingVertical: 12,
  },
  cancelScanText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  // ---- Header ----
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
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 13,
    color: '#6B7280',
  },
  // ---- Scroll content ----
  scrollContent: {
    padding: 16,
    paddingBottom: 48,
    gap: 16,
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  // ---- Barcode row ----
  barcodeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  barcodeInput: {
    flex: 1,
  },
  input: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#F9FAFB',
  },
  scanBtn: {
    backgroundColor: '#EEF2FF',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  scanBtnText: {
    color: '#6366F1',
    fontWeight: '600',
    fontSize: 14,
  },
  productResolved: {
    fontSize: 13,
    color: '#059669',
    fontWeight: '500',
  },
  productUnresolved: {
    fontSize: 12,
    color: '#9CA3AF',
    fontStyle: 'italic',
  },
  // ---- Fields ----
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fieldLabel: {
    fontSize: 14,
    color: '#374151',
    flex: 1,
  },
  inputSmall: {
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
  // ---- Submit ----
  submitBtn: {
    backgroundColor: '#6366F1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  submitBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
