import { zodResolver } from '@hookform/resolvers/zod';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { z } from 'zod';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

const magicLinkSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function LoginScreen() {
  const router = useRouter();
  const { registered } = useLocalSearchParams<{ registered?: string }>();
  const setSession = useAuthStore((state) => state.setSession);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(
    registered === '1' ? 'Account created! Please check your email to confirm, then sign in.' : null,
  );
  const [magicLinkLoading, setMagicLinkLoading] = useState(false);

  const {
    control,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  // ---- password sign-in ----

  const onSubmit = async (data: LoginFormValues) => {
    setErrorMessage(null);
    setSuccessMessage(null);

    const { data: authData, error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    });

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    if (authData.session) {
      setSession(authData.session);
      router.replace('/(app)/dashboard');
    }
  };

  // ---- magic link ----

  const onMagicLink = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);

    const email = getValues('email');
    const result = magicLinkSchema.safeParse({ email });

    if (!result.success) {
      setErrorMessage('Please enter a valid email address to receive a magic link.');
      return;
    }

    setMagicLinkLoading(true);

    const { error } = await supabase.auth.signInWithOtp({ email });

    setMagicLinkLoading(false);

    if (error) {
      setErrorMessage(error.message);
    } else {
      setSuccessMessage('Magic link sent! Check your email to sign in.');
    }
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
        <Text style={styles.title}>Sign In</Text>
        <Text style={styles.subtitle}>AI Inventory Manager</Text>

        {/* Email */}
        <Text style={styles.label}>Email</Text>
        <Controller
          control={control}
          name="email"
          render={({ field: { onChange, onBlur, value } }) => (
            <TextInput
              style={[styles.input, errors.email && styles.inputError]}
              placeholder="you@example.com"
              placeholderTextColor="#9ca3af"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              onBlur={onBlur}
              onChangeText={onChange}
              value={value}
            />
          )}
        />
        {errors.email && (
          <Text style={styles.fieldError}>{errors.email.message}</Text>
        )}

        {/* Password */}
        <Text style={styles.label}>Password</Text>
        <Controller
          control={control}
          name="password"
          render={({ field: { onChange, onBlur, value } }) => (
            <TextInput
              style={[styles.input, errors.password && styles.inputError]}
              placeholder="••••••••"
              placeholderTextColor="#9ca3af"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              onBlur={onBlur}
              onChangeText={onChange}
              value={value}
            />
          )}
        />
        {errors.password && (
          <Text style={styles.fieldError}>{errors.password.message}</Text>
        )}

        {/* Form-level error / success */}
        {errorMessage ? (
          <Text style={styles.errorMessage}>{errorMessage}</Text>
        ) : null}
        {successMessage ? (
          <Text style={styles.successMessage}>{successMessage}</Text>
        ) : null}

        {/* Sign In button */}
        <TouchableOpacity
          style={[styles.primaryButton, isSubmitting && styles.buttonDisabled]}
          onPress={handleSubmit(onSubmit)}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Sign in with email and password"
        >
          {isSubmitting ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.primaryButtonText}>Sign In</Text>
          )}
        </TouchableOpacity>

        {/* Magic Link button */}
        <TouchableOpacity
          style={[styles.secondaryButton, magicLinkLoading && styles.buttonDisabled]}
          onPress={onMagicLink}
          disabled={magicLinkLoading}
          accessibilityRole="button"
          accessibilityLabel="Sign in with magic link"
        >
          {magicLinkLoading ? (
            <ActivityIndicator color="#2563eb" />
          ) : (
            <Text style={styles.secondaryButtonText}>Sign in with Magic Link</Text>
          )}
        </TouchableOpacity>

        {/* Register link */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Don't have an account?</Text>
          <TouchableOpacity
            onPress={() => router.push('/(auth)/register')}
            accessibilityRole="link"
            accessibilityLabel="Go to register screen"
          >
            <Text style={styles.link}> Register</Text>
          </TouchableOpacity>
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
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 15,
    color: '#6b7280',
    marginBottom: 32,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 6,
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
    marginBottom: 12,
  },
  errorMessage: {
    fontSize: 13,
    color: '#ef4444',
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    padding: 12,
    marginTop: 4,
    marginBottom: 16,
  },
  successMessage: {
    fontSize: 13,
    color: '#15803d',
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    padding: 12,
    marginTop: 4,
    marginBottom: 16,
  },
  primaryButton: {
    height: 50,
    backgroundColor: '#2563eb',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
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
    marginTop: 12,
  },
  secondaryButtonText: {
    color: '#2563eb',
    fontSize: 15,
    fontWeight: '500',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 24,
  },
  footerText: {
    fontSize: 14,
    color: '#6b7280',
  },
  link: {
    fontSize: 14,
    color: '#2563eb',
    fontWeight: '500',
  },
});
