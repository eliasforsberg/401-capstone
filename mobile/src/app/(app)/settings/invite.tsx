/**
 * Invite User screen (Owner only)
 *
 * Allows a business owner to invite a new team member by email, assigning
 * one of three roles: Staff, Purchasing, or Accountant.
 *
 * The form calls the `invite-user` Edge Function which:
 *   - validates the caller is an owner
 *   - calls Supabase Auth admin.inviteUserByEmail with metadata
 *
 * Non-owner users see an access-denied message and cannot submit the form.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  ActivityIndicator,
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
import type { UserRole } from '@/types';

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const INVITABLE_ROLES = ['staff', 'purchasing', 'accountant'] as const;
type InvitableRole = (typeof INVITABLE_ROLES)[number];

const inviteSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  role: z.enum(INVITABLE_ROLES, {
    errorMap: () => ({ message: 'Please select a role' }),
  }),
});

type InviteFormValues = z.infer<typeof inviteSchema>;

// ---------------------------------------------------------------------------
// Role option labels
// ---------------------------------------------------------------------------

const ROLE_OPTIONS: { value: InvitableRole; label: string; description: string }[] = [
  {
    value: 'staff',
    label: 'Staff',
    description: 'Can receive stock and perform cycle counts',
  },
  {
    value: 'purchasing',
    label: 'Purchasing',
    description: 'Can manage products, suppliers, and purchase orders',
  },
  {
    value: 'accountant',
    label: 'Accountant',
    description: 'Read-only access to inventory and reports',
  },
];

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function InviteUserScreen() {
  const router = useRouter();
  const role = useAuthStore((s) => s.role) as UserRole | null;

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: {
      email: '',
      role: 'staff',
    },
  });

  // Guard: only owners can access this screen
  if (role !== 'owner') {
    return (
      <View style={styles.centeredContainer}>
        <Text style={styles.accessDeniedIcon}>🔒</Text>
        <Text style={styles.accessDeniedTitle}>Access Restricted</Text>
        <Text style={styles.accessDeniedBody}>
          Only business owners can invite new team members.
        </Text>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const onSubmit = async (data: InviteFormValues) => {
    setSuccessMessage(null);
    setErrorMessage(null);

    const { error } = await supabase.functions.invoke('invite-user', {
      body: { email: data.email, role: data.role },
    });

    if (error) {
      // surface the error message from the Edge Function if available
      const message =
        typeof (error as { message?: string }).message === 'string'
          ? (error as { message: string }).message
          : 'Failed to send invitation. Please try again.';
      setErrorMessage(message);
      return;
    }

    setSuccessMessage(`Invitation sent to ${data.email}.`);
    reset();
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <Text style={styles.title}>Invite Team Member</Text>
        <Text style={styles.subtitle}>
          The invited person will receive an email to set up their account.
        </Text>

        {/* Email field */}
        <Text style={styles.label}>Email Address</Text>
        <Controller
          control={control}
          name="email"
          render={({ field: { onChange, onBlur, value } }) => (
            <TextInput
              style={[styles.input, errors.email && styles.inputError]}
              placeholder="colleague@example.com"
              placeholderTextColor="#9ca3af"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              onBlur={onBlur}
              onChangeText={onChange}
              value={value}
              accessibilityLabel="Email address"
            />
          )}
        />
        {errors.email ? (
          <Text style={styles.fieldError}>{errors.email.message}</Text>
        ) : null}

        {/* Role picker */}
        <Text style={[styles.label, styles.roleSectionLabel]}>Role</Text>
        <Controller
          control={control}
          name="role"
          render={({ field: { onChange, value } }) => (
            <View style={styles.roleList}>
              {ROLE_OPTIONS.map((option) => {
                const isSelected = value === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.roleOption,
                      isSelected && styles.roleOptionSelected,
                    ]}
                    onPress={() => onChange(option.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={`${option.label}: ${option.description}`}
                  >
                    <View style={styles.roleRadio}>
                      {isSelected && <View style={styles.roleRadioInner} />}
                    </View>
                    <View style={styles.roleTextContainer}>
                      <Text
                        style={[
                          styles.roleLabel,
                          isSelected && styles.roleLabelSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                      <Text style={styles.roleDescription}>{option.description}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        />
        {errors.role ? (
          <Text style={styles.fieldError}>{errors.role.message}</Text>
        ) : null}

        {/* Success banner */}
        {successMessage ? (
          <View style={styles.successBanner} accessibilityLiveRegion="polite">
            <Text style={styles.successText}>✓ {successMessage}</Text>
          </View>
        ) : null}

        {/* Error banner */}
        {errorMessage ? (
          <View style={styles.errorBanner} accessibilityLiveRegion="assertive">
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* Submit */}
        <TouchableOpacity
          style={[styles.primaryButton, isSubmitting && styles.buttonDisabled]}
          onPress={handleSubmit(onSubmit)}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Send invitation"
        >
          {isSubmitting ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.primaryButtonText}>Send Invitation</Text>
          )}
        </TouchableOpacity>

        {/* Cancel / back */}
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Cancel and go back"
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
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
  container: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingVertical: 40,
  },

  // ── Access denied ──
  centeredContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: '#f9fafb',
  },
  accessDeniedIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  accessDeniedTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
    textAlign: 'center',
  },
  accessDeniedBody: {
    fontSize: 15,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  backButton: {
    height: 46,
    paddingHorizontal: 28,
    backgroundColor: '#e5e7eb',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#374151',
  },

  // ── Header ──
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 32,
    lineHeight: 20,
  },

  // ── Fields ──
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 6,
  },
  roleSectionLabel: {
    marginTop: 20,
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
    marginBottom: 4,
  },
  inputError: {
    borderColor: '#ef4444',
  },
  fieldError: {
    fontSize: 12,
    color: '#ef4444',
    marginBottom: 8,
  },

  // ── Role picker ──
  roleList: {
    gap: 10,
    marginBottom: 4,
  },
  roleOption: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 14,
    borderWidth: 1.5,
    borderColor: '#d1d5db',
    borderRadius: 10,
    backgroundColor: '#ffffff',
  },
  roleOptionSelected: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  roleRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#9ca3af',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    marginRight: 12,
  },
  roleRadioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#2563eb',
  },
  roleTextContainer: {
    flex: 1,
  },
  roleLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 2,
  },
  roleLabelSelected: {
    color: '#1d4ed8',
  },
  roleDescription: {
    fontSize: 13,
    color: '#6b7280',
    lineHeight: 18,
  },

  // ── Banners ──
  successBanner: {
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#86efac',
    padding: 12,
    marginTop: 16,
    marginBottom: 4,
  },
  successText: {
    fontSize: 14,
    color: '#166534',
    fontWeight: '500',
  },
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fca5a5',
    padding: 12,
    marginTop: 16,
    marginBottom: 4,
  },
  errorText: {
    fontSize: 14,
    color: '#991b1b',
  },

  // ── Buttons ──
  primaryButton: {
    height: 50,
    backgroundColor: '#2563eb',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  cancelButton: {
    height: 46,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  cancelButtonText: {
    fontSize: 15,
    color: '#6b7280',
    fontWeight: '500',
  },
});
