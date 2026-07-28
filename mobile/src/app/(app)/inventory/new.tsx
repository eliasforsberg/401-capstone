/**
 * New Product Creation Screen
 *
 * Multi-step form for creating a new product with barcode assignment and
 * optional image upload to Supabase Storage.
 *
 * Steps:
 *   1. Basic info  — SKU (auto-suggested), name, description, category, unit_of_measure
 *   2. Reorder     — reorder_point, reorder_quantity, safety_stock, lead_time_days, default_supplier_id
 *   3. Barcode     — scan via expo-camera or manually enter; uniqueness enforced
 *   4. Image       — capture photo via expo-camera; upload to product-images bucket
 *
 * Guard: redirects users without owner or purchasing role.
 *
 * Requirements: 7.3, 7.5, 7.6, 7.8
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { z } from 'zod';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import { useCreateProduct } from '@/hooks/useProducts';
import { useSuppliers } from '@/hooks/useSuppliers';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const step1Schema = z.object({
  sku: z.string().min(1, 'SKU is required'),
  name: z.string().min(1, 'Product name is required'),
  description: z.string().optional(),
  category: z.string().optional(),
  unit_of_measure: z.string().min(1, 'Unit of measure is required'),
});

const step2Schema = z.object({
  reorder_point: z.coerce.number().min(0, 'Must be ≥ 0').default(0),
  reorder_quantity: z.coerce.number().min(1, 'Must be ≥ 1').default(1),
  safety_stock: z.coerce.number().min(0, 'Must be ≥ 0').default(0),
  lead_time_days: z.coerce.number().min(0).optional(),
  default_supplier_id: z.string().optional(),
});

const fullSchema = step1Schema.merge(step2Schema);

type FormValues = z.infer<typeof fullSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 4;

const UNIT_OPTIONS = ['each', 'kg', 'g', 'lb', 'oz', 'L', 'mL', 'box', 'case', 'pack', 'pair'];

// ---------------------------------------------------------------------------
// Helper — generate SKU slug from product name
// ---------------------------------------------------------------------------

function slugifyName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
}

// ---------------------------------------------------------------------------
// Screen component
// ---------------------------------------------------------------------------

export default function NewProductScreen() {
  const router = useRouter();
  const role = useAuthStore((s) => s.role);
  const businessId = useAuthStore((s) => s.businessId);

  // Guard — redirect if not owner or purchasing
  if (role !== 'owner' && role !== 'purchasing') {
    return (
      <View style={styles.guardContainer}>
        <Text style={styles.guardTitle}>Access Denied</Text>
        <Text style={styles.guardText}>
          Only Owner and Purchasing users can create products.
        </Text>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => router.back()}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return <NewProductForm businessId={businessId!} />;
}

// ---------------------------------------------------------------------------
// Inner form component (receives guaranteed businessId)
// ---------------------------------------------------------------------------

function NewProductForm({ businessId }: { businessId: string }) {
  const router = useRouter();
  const createProduct = useCreateProduct();
  const { data: suppliers = [] } = useSuppliers();

  // Step state: 1 | 2 | 3 | 4
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // SKU uniqueness state
  const [skuConflict, setSkuConflict] = useState<string | null>(null);
  const [skuChecking, setSkuChecking] = useState(false);
  const [skuConfirmed, setSkuConfirmed] = useState(false);

  // Barcode state
  const [barcodeValue, setBarcodeValue] = useState('');
  const [barcodeManualInput, setBarcodeManualInput] = useState('');
  const [barcodeConflict, setBarcodeConflict] = useState<string | null>(null);
  const [barcodeChecking, setBarcodeChecking] = useState(false);
  const [barcodeConfirmed, setBarcodeConfirmed] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  // Image state
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [imageCameraPermission, requestImageCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [capturingPhoto, setCapturingPhoto] = useState(false);

  // Submission state
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    getValues,
    setValue,
    watch,
    trigger,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(fullSchema),
    defaultValues: {
      sku: '',
      name: '',
      description: '',
      category: '',
      unit_of_measure: 'each',
      reorder_point: 0,
      reorder_quantity: 1,
      safety_stock: 0,
      lead_time_days: undefined,
      default_supplier_id: '',
    },
  });

  // ---- SKU uniqueness check ----
  const checkSkuUniqueness = useCallback(
    async (value: string) => {
      if (!value.trim()) {
        setSkuConflict(null);
        setSkuConfirmed(false);
        return;
      }
      setSkuChecking(true);
      setSkuConflict(null);
      setSkuConfirmed(false);

      try {
        const { data, error } = await supabase
          .from('products')
          .select('sku, name')
          .eq('business_id', businessId)
          .eq('sku', value.trim())
          .eq('is_active', true)
          .maybeSingle();

        if (error) throw error;

        if (data) {
          setSkuConflict(`SKU already used by "${data.name}".`);
          setSkuConfirmed(false);
        } else {
          setSkuConflict(null);
          setSkuConfirmed(true);
        }
      } catch {
        setSkuConflict('Could not verify SKU. Please try again.');
      } finally {
        setSkuChecking(false);
      }
    },
    [businessId],
  );

  // ---- Auto-suggest SKU from name ----
  const handleNameChange = useCallback(
    (name: string, fieldOnChange: (v: string) => void) => {
      fieldOnChange(name);
      const currentSku = getValues('sku');
      if (!currentSku || currentSku === slugifyName(getValues('name'))) {
        const newSku = slugifyName(name);
        setValue('sku', newSku);
        // Reset SKU uniqueness state when auto-suggested value changes
        setSkuConflict(null);
        setSkuConfirmed(false);
      }
    },
    [getValues, setValue],
  );

  // ---- Step navigation with validation ----
  const advanceStep = useCallback(async () => {
    let valid = false;
    if (step === 1) {
      valid = await trigger(['sku', 'name', 'unit_of_measure']);
      if (valid && skuConflict) {
        // Already know there's a conflict
        valid = false;
      } else if (valid && !skuConfirmed) {
        // SKU hasn't been checked yet — verify before advancing
        const skuValue = getValues('sku').trim();
        if (!skuValue) {
          valid = false;
        } else {
          setSkuChecking(true);
          try {
            const { data, error } = await supabase
              .from('products')
              .select('sku, name')
              .eq('business_id', businessId)
              .eq('sku', skuValue)
              .eq('is_active', true)
              .maybeSingle();

            if (error) throw error;

            if (data) {
              setSkuConflict(`SKU already used by "${data.name}".`);
              setSkuConfirmed(false);
              valid = false;
            } else {
              setSkuConflict(null);
              setSkuConfirmed(true);
            }
          } catch {
            setSkuConflict('Could not verify SKU. Please try again.');
            valid = false;
          } finally {
            setSkuChecking(false);
          }
        }
      }
    } else if (step === 2) {
      valid = await trigger(['reorder_point', 'reorder_quantity', 'safety_stock']);
    } else if (step === 3) {
      // Barcode step — either confirmed unique or skipped
      valid = true;
    }
    if (valid) setStep((s) => (s < 4 ? ((s + 1) as 1 | 2 | 3 | 4) : s));
  }, [step, trigger, skuConflict, skuConfirmed, getValues, businessId]);

  const goBack = useCallback(() => {
    if (step > 1) setStep((s) => (s - 1) as 1 | 2 | 3 | 4);
    else router.back();
  }, [step, router]);

  // ---- Barcode uniqueness check ----
  const checkBarcodeUniqueness = useCallback(
    async (value: string) => {
      if (!value.trim()) return;
      setBarcodeChecking(true);
      setBarcodeConflict(null);
      setBarcodeConfirmed(false);

      try {
        const { data, error } = await supabase
          .from('product_barcodes')
          .select('barcode_value, products(name)')
          .eq('business_id', businessId)
          .eq('barcode_value', value.trim())
          .maybeSingle();

        if (error) throw error;

        if (data) {
          const productName =
            (data.products as { name: string } | null)?.name ?? 'another product';
          setBarcodeConflict(`Already assigned to "${productName}". Tap to view.`);
          setBarcodeConfirmed(false);
        } else {
          setBarcodeConflict(null);
          setBarcodeConfirmed(true);
          setBarcodeValue(value.trim());
        }
      } catch (err) {
        setBarcodeConflict('Could not verify barcode. Please try again.');
      } finally {
        setBarcodeChecking(false);
      }
    },
    [businessId],
  );

  // ---- Barcode scan handler ----
  const handleBarcodeScan = useCallback(
    ({ data }: { data: string }) => {
      setShowScanner(false);
      setBarcodeManualInput(data);
      checkBarcodeUniqueness(data);
    },
    [checkBarcodeUniqueness],
  );

  // ---- Camera photo capture ----
  const handleTakePhoto = useCallback(async () => {
    if (!cameraRef.current) return;
    setCapturingPhoto(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7 });
      if (photo?.uri) {
        setImageUri(photo.uri);
        setShowCamera(false);
      }
    } catch {
      Alert.alert('Error', 'Could not capture photo. Please try again.');
    } finally {
      setCapturingPhoto(false);
    }
  }, []);

  // ---- Upload image to Supabase Storage ----
  const uploadImage = useCallback(
    async (productId: string): Promise<string | null> => {
      if (!imageUri) return null;

      const fileExt = imageUri.split('.').pop() ?? 'jpg';
      const fileName = `${businessId}/${productId}.${fileExt}`;

      // Read file as blob via fetch (works in Expo managed workflow)
      const response = await fetch(imageUri);
      const blob = await response.blob();

      const { data, error } = await supabase.storage
        .from('product-images')
        .upload(fileName, blob, {
          contentType: `image/${fileExt}`,
          upsert: true,
        });

      if (error) {
        console.error('[NewProduct] Image upload failed:', error.message);
        return null;
      }

      return data.path;
    },
    [imageUri, businessId],
  );

  // ---- Final submit ----
  const onSubmit = useCallback(
    async (values: FormValues) => {
      setSubmitError(null);

      try {
        // 1. Create product (image_storage_path set after upload)
        const product = await createProduct.mutateAsync({
          sku: values.sku,
          name: values.name,
          description: values.description || undefined,
          category: values.category || undefined,
          unit_of_measure: values.unit_of_measure,
          reorder_point: values.reorder_point,
          reorder_quantity: values.reorder_quantity,
          safety_stock: values.safety_stock,
          lead_time_days: values.lead_time_days || undefined,
          default_supplier_id: values.default_supplier_id || undefined,
        });

        // 2. Insert barcode if one was confirmed unique
        if (barcodeValue && barcodeConfirmed) {
          const { error: barcodeError } = await supabase
            .from('product_barcodes')
            .insert({
              business_id: businessId,
              product_id: product.product_id,
              barcode_value: barcodeValue,
            });

          if (barcodeError) {
            console.error('[NewProduct] Barcode insert failed:', barcodeError.message);
            // Non-fatal — product is created; surface a warning
            Alert.alert(
              'Product Created',
              `Product was saved but barcode could not be saved: ${barcodeError.message}`,
            );
          }
        }

        // 3. Upload image if captured
        if (imageUri) {
          const storagePath = await uploadImage(product.product_id);
          if (storagePath) {
            // Update product with storage path
            await supabase
              .from('products')
              .update({ image_storage_path: storagePath })
              .eq('product_id', product.product_id);
          }
        }

        // 4. Navigate to product detail
        router.replace(`/(app)/inventory/${product.product_id}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create product';
        setSubmitError(message);
      }
    },
    [createProduct, barcodeValue, barcodeConfirmed, imageUri, uploadImage, businessId, router],
  );

  // ---- Barcode scanner modal overlay ----
  if (showScanner) {
    return (
      <View style={styles.fullScreen}>
        {cameraPermission?.granted ? (
          <CameraView
            style={styles.fullScreen}
            barcodeScannerSettings={{
              barcodeTypes: [
                'upc_a', 'upc_e', 'ean13', 'ean8',
                'code128', 'code39', 'qr', 'datamatrix',
              ],
            }}
            onBarcodeScanned={handleBarcodeScan}
          />
        ) : (
          <View style={styles.permissionContainer}>
            <Text style={styles.permissionText}>Camera access is required to scan barcodes.</Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={requestCameraPermission}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>Grant Camera Access</Text>
            </TouchableOpacity>
          </View>
        )}
        <TouchableOpacity
          style={styles.cancelOverlayButton}
          onPress={() => setShowScanner(false)}
          accessibilityRole="button"
          accessibilityLabel="Cancel barcode scan"
        >
          <Text style={styles.cancelOverlayText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ---- Camera photo capture modal overlay ----
  if (showCamera) {
    return (
      <View style={styles.fullScreen}>
        {imageCameraPermission?.granted ? (
          <>
            <CameraView ref={cameraRef} style={styles.fullScreen} facing="back" />
            <View style={styles.cameraControls}>
              <TouchableOpacity
                style={styles.captureButton}
                onPress={handleTakePhoto}
                disabled={capturingPhoto}
                accessibilityRole="button"
                accessibilityLabel="Take photo"
              >
                {capturingPhoto ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <View style={styles.captureButtonInner} />
                )}
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <View style={styles.permissionContainer}>
            <Text style={styles.permissionText}>Camera access is required to take a photo.</Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={requestImageCameraPermission}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>Grant Camera Access</Text>
            </TouchableOpacity>
          </View>
        )}
        <TouchableOpacity
          style={styles.cancelOverlayButton}
          onPress={() => setShowCamera(false)}
          accessibilityRole="button"
          accessibilityLabel="Cancel photo"
        >
          <Text style={styles.cancelOverlayText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ---- Main form render ----
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={styles.backButton}
        >
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>New Product</Text>
        <Text style={styles.stepIndicator}>
          Step {step} of {TOTAL_STEPS}
        </Text>
      </View>

      {/* Progress bar */}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${(step / TOTAL_STEPS) * 100}%` }]} />
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* ---------------------------------------------------------------- */}
        {/* Step 1: Basic Info                                               */}
        {/* ---------------------------------------------------------------- */}
        {step === 1 && (
          <View>
            <Text style={styles.stepTitle}>Basic Information</Text>

            <Text style={styles.label}>Product Name *</Text>
            <Controller
              control={control}
              name="name"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  style={[styles.input, errors.name && styles.inputError]}
                  placeholder="e.g. Coca-Cola 355mL"
                  placeholderTextColor="#9ca3af"
                  onBlur={onBlur}
                  onChangeText={(v) => handleNameChange(v, onChange)}
                  value={value}
                  accessibilityLabel="Product name"
                />
              )}
            />
            {errors.name && <Text style={styles.fieldError}>{errors.name.message}</Text>}

            <Text style={styles.label}>SKU *</Text>
            <Controller
              control={control}
              name="sku"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  style={[styles.input, (errors.sku || skuConflict) && styles.inputError]}
                  placeholder="Auto-suggested from name"
                  placeholderTextColor="#9ca3af"
                  autoCapitalize="characters"
                  onBlur={() => {
                    onBlur();
                    checkSkuUniqueness(value);
                  }}
                  onChangeText={(v) => {
                    onChange(v);
                    setSkuConflict(null);
                    setSkuConfirmed(false);
                  }}
                  value={value}
                  accessibilityLabel="Product SKU"
                />
              )}
            />
            {errors.sku && <Text style={styles.fieldError}>{errors.sku.message}</Text>}
            {skuChecking && (
              <View style={styles.row}>
                <ActivityIndicator size="small" color="#2563eb" style={{ marginRight: 6 }} />
                <Text style={styles.hint}>Checking SKU availability…</Text>
              </View>
            )}
            {skuConflict && (
              <View style={styles.conflictBanner}>
                <Text style={styles.conflictText}>⚠ {skuConflict}</Text>
              </View>
            )}
            {skuConfirmed && !skuConflict && (
              <View style={styles.successBanner}>
                <Text style={styles.successBannerText}>✓ SKU is available.</Text>
              </View>
            )}

            <Text style={styles.label}>Description</Text>
            <Controller
              control={control}
              name="description"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  style={[styles.input, styles.textArea]}
                  placeholder="Optional product description"
                  placeholderTextColor="#9ca3af"
                  multiline
                  numberOfLines={3}
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={value}
                  accessibilityLabel="Product description"
                />
              )}
            />

            <Text style={styles.label}>Category</Text>
            <Controller
              control={control}
              name="category"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Beverages, Snacks, Tobacco"
                  placeholderTextColor="#9ca3af"
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={value}
                  accessibilityLabel="Product category"
                />
              )}
            />

            <Text style={styles.label}>Unit of Measure *</Text>
            <View style={styles.chipRow}>
              {UNIT_OPTIONS.map((unit) => {
                const selected = watch('unit_of_measure') === unit;
                return (
                  <TouchableOpacity
                    key={unit}
                    style={[styles.chip, selected && styles.chipSelected]}
                    onPress={() => setValue('unit_of_measure', unit)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Unit: ${unit}`}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                      {unit}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {errors.unit_of_measure && (
              <Text style={styles.fieldError}>{errors.unit_of_measure.message}</Text>
            )}
          </View>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Step 2: Reorder Settings                                         */}
        {/* ---------------------------------------------------------------- */}
        {step === 2 && (
          <View>
            <Text style={styles.stepTitle}>Reorder Settings</Text>

            <Text style={styles.label}>Reorder Point</Text>
            <Text style={styles.hint}>Alert when stock falls to or below this level.</Text>
            <Controller
              control={control}
              name="reorder_point"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  style={[styles.input, errors.reorder_point && styles.inputError]}
                  placeholder="0"
                  placeholderTextColor="#9ca3af"
                  keyboardType="numeric"
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={String(value ?? '')}
                  accessibilityLabel="Reorder point"
                />
              )}
            />
            {errors.reorder_point && (
              <Text style={styles.fieldError}>{errors.reorder_point.message}</Text>
            )}

            <Text style={styles.label}>Reorder Quantity</Text>
            <Text style={styles.hint}>Suggested quantity to order when restocking.</Text>
            <Controller
              control={control}
              name="reorder_quantity"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  style={[styles.input, errors.reorder_quantity && styles.inputError]}
                  placeholder="1"
                  placeholderTextColor="#9ca3af"
                  keyboardType="numeric"
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={String(value ?? '')}
                  accessibilityLabel="Reorder quantity"
                />
              )}
            />
            {errors.reorder_quantity && (
              <Text style={styles.fieldError}>{errors.reorder_quantity.message}</Text>
            )}

            <Text style={styles.label}>Safety Stock</Text>
            <Text style={styles.hint}>Buffer units held above the reorder point.</Text>
            <Controller
              control={control}
              name="safety_stock"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  style={[styles.input, errors.safety_stock && styles.inputError]}
                  placeholder="0"
                  placeholderTextColor="#9ca3af"
                  keyboardType="numeric"
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={String(value ?? '')}
                  accessibilityLabel="Safety stock"
                />
              )}
            />
            {errors.safety_stock && (
              <Text style={styles.fieldError}>{errors.safety_stock.message}</Text>
            )}

            <Text style={styles.label}>Lead Time (days)</Text>
            <Controller
              control={control}
              name="lead_time_days"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  style={styles.input}
                  placeholder="Optional"
                  placeholderTextColor="#9ca3af"
                  keyboardType="numeric"
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={value !== undefined ? String(value) : ''}
                  accessibilityLabel="Lead time in days"
                />
              )}
            />

            <Text style={styles.label}>Default Supplier</Text>
            {suppliers.length === 0 ? (
              <Text style={styles.hint}>No suppliers found. You can add one in Settings.</Text>
            ) : (
              <View style={styles.supplierList}>
                {/* "None" option */}
                <TouchableOpacity
                  style={[
                    styles.supplierRow,
                    !watch('default_supplier_id') && styles.supplierRowSelected,
                  ]}
                  onPress={() => setValue('default_supplier_id', '')}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: !watch('default_supplier_id') }}
                >
                  <Text style={styles.supplierRowText}>None</Text>
                </TouchableOpacity>
                {suppliers.map((supplier) => {
                  const isSelected = watch('default_supplier_id') === supplier.supplier_id;
                  return (
                    <TouchableOpacity
                      key={supplier.supplier_id}
                      style={[styles.supplierRow, isSelected && styles.supplierRowSelected]}
                      onPress={() => setValue('default_supplier_id', supplier.supplier_id)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                    >
                      <Text style={styles.supplierRowText}>{supplier.name}</Text>
                      {supplier.lead_time_days != null && (
                        <Text style={styles.supplierMeta}>
                          Lead time: {supplier.lead_time_days}d
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Step 3: Barcode                                                  */}
        {/* ---------------------------------------------------------------- */}
        {step === 3 && (
          <View>
            <Text style={styles.stepTitle}>Barcode Assignment</Text>
            <Text style={styles.hint}>
              Scan a barcode with the camera or enter it manually.
              You can skip this step and add barcodes later.
            </Text>

            {/* Manual entry */}
            <Text style={styles.label}>Barcode Value</Text>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.inputFlex, barcodeConflict && styles.inputError]}
                placeholder="Enter barcode manually"
                placeholderTextColor="#9ca3af"
                value={barcodeManualInput}
                onChangeText={(v) => {
                  setBarcodeManualInput(v);
                  setBarcodeConflict(null);
                  setBarcodeConfirmed(false);
                }}
                autoCapitalize="none"
                accessibilityLabel="Barcode value"
              />
              <TouchableOpacity
                style={styles.scanButton}
                onPress={() => setShowScanner(true)}
                accessibilityRole="button"
                accessibilityLabel="Open barcode scanner"
              >
                <Text style={styles.scanButtonText}>Scan</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[
                styles.secondaryButton,
                (barcodeChecking || !barcodeManualInput.trim()) && styles.buttonDisabled,
              ]}
              onPress={() => checkBarcodeUniqueness(barcodeManualInput)}
              disabled={barcodeChecking || !barcodeManualInput.trim()}
              accessibilityRole="button"
            >
              {barcodeChecking ? (
                <ActivityIndicator color="#2563eb" />
              ) : (
                <Text style={styles.secondaryButtonText}>Check Barcode</Text>
              )}
            </TouchableOpacity>

            {/* Conflict message */}
            {barcodeConflict && (
              <View style={styles.conflictBanner}>
                <Text style={styles.conflictText}>⚠ {barcodeConflict}</Text>
              </View>
            )}

            {/* Confirmed message */}
            {barcodeConfirmed && !barcodeConflict && (
              <View style={styles.successBanner}>
                <Text style={styles.successBannerText}>
                  ✓ Barcode "{barcodeValue}" is available and will be assigned.
                </Text>
              </View>
            )}
          </View>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Step 4: Image                                                    */}
        {/* ---------------------------------------------------------------- */}
        {step === 4 && (
          <View>
            <Text style={styles.stepTitle}>Product Image</Text>
            <Text style={styles.hint}>
              Optionally attach a product photo. You can skip this step.
            </Text>

            {imageUri ? (
              <View style={styles.imagePreviewContainer}>
                <Image
                  source={{ uri: imageUri }}
                  style={styles.imagePreview}
                  accessibilityLabel="Product image preview"
                />
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => setImageUri(null)}
                  accessibilityRole="button"
                >
                  <Text style={styles.secondaryButtonText}>Remove Photo</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.imagePlaceholder}
                onPress={() => setShowCamera(true)}
                accessibilityRole="button"
                accessibilityLabel="Take product photo"
              >
                <Text style={styles.imagePlaceholderIcon}>📷</Text>
                <Text style={styles.imagePlaceholderText}>Tap to take a photo</Text>
              </TouchableOpacity>
            )}

            {/* Submit error */}
            {submitError && (
              <View style={styles.conflictBanner}>
                <Text style={styles.conflictText}>{submitError}</Text>
              </View>
            )}
          </View>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Navigation buttons                                               */}
        {/* ---------------------------------------------------------------- */}
        <View style={styles.navRow}>
          {step < 4 && (
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={advanceStep}
              accessibilityRole="button"
              accessibilityLabel="Next step"
            >
              <Text style={styles.primaryButtonText}>Next</Text>
            </TouchableOpacity>
          )}

          {step === 4 && (
            <TouchableOpacity
              style={[styles.primaryButton, createProduct.isPending && styles.buttonDisabled]}
              onPress={handleSubmit(onSubmit)}
              disabled={createProduct.isPending}
              accessibilityRole="button"
              accessibilityLabel={imageUri ? 'Create product with image' : 'Create product'}
            >
              {createProduct.isPending ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  {imageUri ? 'Create Product' : 'Create Without Image'}
                </Text>
              )}
            </TouchableOpacity>
          )}

          {step === 3 && !barcodeConfirmed && (
            <TouchableOpacity
              style={styles.skipButton}
              onPress={advanceStep}
              accessibilityRole="button"
              accessibilityLabel="Skip barcode step"
            >
              <Text style={styles.skipButtonText}>Skip</Text>
            </TouchableOpacity>
          )}
        </View>
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
    backgroundColor: '#f9fafb',
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 48,
  },

  // Guard
  guardContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#f9fafb',
  },
  guardTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  guardText: {
    fontSize: 15,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 24,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 56 : 16,
    paddingBottom: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backButton: {
    padding: 4,
  },
  backButtonText: {
    fontSize: 17,
    color: '#2563eb',
    fontWeight: '500',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111827',
  },
  stepIndicator: {
    fontSize: 13,
    color: '#6b7280',
  },

  // Progress bar
  progressTrack: {
    height: 3,
    backgroundColor: '#e5e7eb',
  },
  progressFill: {
    height: 3,
    backgroundColor: '#2563eb',
  },

  // Step title
  stepTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
    marginTop: 4,
  },

  // Form elements
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    marginTop: 16,
    marginBottom: 6,
  },
  hint: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 8,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 15,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  inputFlex: {
    flex: 1,
    marginRight: 8,
  },
  inputError: {
    borderColor: '#ef4444',
  },
  textArea: {
    height: 80,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  fieldError: {
    fontSize: 12,
    color: '#ef4444',
    marginTop: 4,
  },

  // Unit chips
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  chipSelected: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  chipText: {
    fontSize: 13,
    color: '#374151',
  },
  chipTextSelected: {
    color: '#2563eb',
    fontWeight: '600',
  },

  // Supplier list
  supplierList: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 4,
  },
  supplierRow: {
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    backgroundColor: '#ffffff',
  },
  supplierRowSelected: {
    backgroundColor: '#eff6ff',
  },
  supplierRowText: {
    fontSize: 15,
    color: '#111827',
  },
  supplierMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },

  // Barcode
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scanButton: {
    height: 48,
    paddingHorizontal: 16,
    backgroundColor: '#2563eb',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  conflictBanner: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fca5a5',
  },
  conflictText: {
    fontSize: 13,
    color: '#b91c1c',
  },
  successBanner: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#86efac',
  },
  successBannerText: {
    fontSize: 13,
    color: '#15803d',
  },

  // Image
  imagePreviewContainer: {
    alignItems: 'center',
    gap: 12,
  },
  imagePreview: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    resizeMode: 'cover',
  },
  imagePlaceholder: {
    height: 180,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#d1d5db',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f9fafb',
  },
  imagePlaceholderIcon: {
    fontSize: 40,
    marginBottom: 8,
  },
  imagePlaceholderText: {
    fontSize: 14,
    color: '#6b7280',
  },

  // Navigation
  navRow: {
    marginTop: 32,
    gap: 12,
  },
  primaryButton: {
    height: 50,
    backgroundColor: '#2563eb',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    height: 50,
    borderWidth: 1.5,
    borderColor: '#2563eb',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  secondaryButtonText: {
    color: '#2563eb',
    fontSize: 15,
    fontWeight: '500',
  },
  skipButton: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipButtonText: {
    fontSize: 15,
    color: '#6b7280',
  },
  buttonDisabled: {
    opacity: 0.6,
  },

  // Camera overlay
  fullScreen: {
    flex: 1,
    backgroundColor: '#000000',
  },
  permissionContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  permissionText: {
    fontSize: 15,
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: 24,
  },
  cancelOverlayButton: {
    position: 'absolute',
    bottom: 48,
    alignSelf: 'center',
    paddingVertical: 12,
    paddingHorizontal: 32,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 24,
  },
  cancelOverlayText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  cameraControls: {
    position: 'absolute',
    bottom: 60,
    width: '100%',
    alignItems: 'center',
  },
  captureButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#ffffff',
  },
  captureButtonInner: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#ffffff',
  },
});
