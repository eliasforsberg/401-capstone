import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
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

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const registerSchema = z
  .object({
    displayName: z
      .string()
      .min(2, 'Display name must be at least 2 characters')
      .max(50, 'Display name must be 50 characters or fewer'),
    email: z.string().email('Please enter a valid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type RegisterFormValues = z.infer<typeof registerSchema>;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function RegisterScreen() {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      displayName: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  });

  const onSubmit = async (data: RegisterFormValues) => {
    setErrorMessage(null);

    // Step 1: create the Supabase Auth account
    const { data: authData, error: signUpError } = await supabase.auth.signUp({
      email: data.email,
      password: data.password,
    });

    if (signUpError) {
      setErrorMessage(signUpError.message);
      return;
    }

    const userId = authData.user?.id;
    if (!userId) {
      setErrorMessage('Sign-up succeeded but no user ID was returned. Please try again.');
      return;
    }

    // Step 2: insert user_profiles row.
    // business_id is null at registration time — the user will be invited to or
    // create a business separately (MVP flow).
    const { error: profileError } = await supabase.from('user_profiles').insert({
      user_id: userId,
      business_id: null, // will be assigned when user joins or creates a business
      display_name: data.displayName,
    });

    if (profileError) {
      // Non-fatal in the sense that auth succeeded; log but surface to user.
      setErrorMessage(
        `Account created but profile setup failed: ${profileError.message}. Please contact support.`,
      );
      return;
    }

    // Step 3: navigate to login with a success indicator
    // Use replace so the user cannot navigate back to the register form.
    router.replace({
      pathname: '/(auth)/login',
      params: { registered: '1' },
    });
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
        <Text style={styles.title}>Create Account</Text>
        <Text style={styles.subtitle}>Set up your inventory account</Text>

        {/* Display Name */}
        <Text style={styles.label}>Display Name</Text>
        <Controller
          control={control}
          name="displayName"
          render={({ field: { onChange, onBlur, value } }) => (
            <TextInput
              style={[styles.input, errors.displayName && styles.inputError]}
              placeholder="Your name"
              placeholderTextColor="#9ca3af"
              autoCapitalize="words"
              autoCorrect={false}
              onBlur={onBlur}
              onChangeText={onChange}
              value={value}
            />
          )}
        />
        {errors.displayName && (
          <Text style={styles.fieldError}>{errors.displayName.message}</Text>
        )}

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
              placeholder="At least 8 characters"
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

        {/* Confirm Password */}
        <Text style={styles.label}>Confirm Password</Text>
        <Controller
          control={control}
          name="confirmPassword"
          render={({ field: { onChange, onBlur, value } }) => (
            <TextInput
              style={[styles.input, errors.confirmPassword && styles.inputError]}
              placeholder="Re-enter your password"
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
        {errors.confirmPassword && (
          <Text style={styles.fieldError}>{errors.confirmPassword.message}</Text>
        )}

        {/* Form-level error */}
        {errorMessage ? (
          <Text style={styles.errorMessage}>{errorMessage}</Text>
        ) : null}

        {/* Submit button */}
        <TouchableOpacity
          style={[styles.primaryButton, isSubmitting && styles.buttonDisabled]}
          onPress={handleSubmit(onSubmit)}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Create account"
        >
          {isSubmitting ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.primaryButtonText}>Create Account</Text>
          )}
        </TouchableOpacity>

        {/* Login link */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account?</Text>
          <TouchableOpacity
            onPress={() => router.push('/(auth)/login')}
            accessibilityRole="link"
            accessibilityLabel="Go to login screen"
          >
            <Text style={styles.link}> Login</Text>
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
