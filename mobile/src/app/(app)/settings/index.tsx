/**
 * Settings screen
 *
 * Provides navigation links to team management flows and, for Owners only,
 * a "Run Ledger Consistency Check" button that calls the `health-check`
 * Edge Function and displays the result inline.
 *
 * Requirements: 15.3
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// Types (matches health-check Edge Function response shape)
// ---------------------------------------------------------------------------

interface Inconsistency {
  sku_id: string;
  location_id: string;
  stored_balance: number;
  computed_balance: number;
  delta: number;
}

interface HealthCheckResult {
  status: 'ok' | 'inconsistencies_found';
  checked_count: number;
  inconsistencies: Inconsistency[];
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const router = useRouter();
  const role = useAuthStore((s) => s.role);
  const isOwner = role === 'owner';

  // ---- Health-check state ----
  const [checkLoading, setCheckLoading] = useState(false);
  const [checkResult, setCheckResult] = useState<HealthCheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const runConsistencyCheck = async () => {
    setCheckLoading(true);
    setCheckResult(null);
    setCheckError(null);

    try {
      const { data, error } = await supabase.functions.invoke<HealthCheckResult>(
        'health-check',
        {},
      );

      if (error) {
        const msg =
          typeof (error as { message?: string }).message === 'string'
            ? (error as { message: string }).message
            : 'Consistency check failed. Please try again.';
        setCheckError(msg);
        return;
      }

      if (data) {
        setCheckResult(data);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'An unexpected error occurred.';
      setCheckError(msg);
    } finally {
      setCheckLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const renderCheckResult = () => {
    if (!checkResult) return null;

    if (checkResult.status === 'ok') {
      return (
        <View
          style={styles.resultBannerOk}
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
        >
          <Text style={styles.resultIconOk}>✓</Text>
          <Text style={styles.resultTextOk}>
            All {checkResult.checked_count} balance
            {checkResult.checked_count !== 1 ? 's' : ''} verified — no inconsistencies
          </Text>
        </View>
      );
    }

    // inconsistencies_found
    return (
      <View
        style={styles.resultBannerWarn}
        accessibilityLiveRegion="assertive"
        accessibilityRole="alert"
      >
        <Text style={styles.resultTitleWarn}>
          ⚠ {checkResult.inconsistencies.length} inconsistenc
          {checkResult.inconsistencies.length !== 1 ? 'ies' : 'y'} found (
          {checkResult.checked_count} checked)
        </Text>
        {checkResult.inconsistencies.map((item, index) => (
          <View key={`${item.sku_id}-${item.location_id}`} style={styles.inconsistencyRow}>
            {index > 0 && <View style={styles.inconsistencyDivider} />}
            <Text style={styles.inconsistencyLabel}>SKU ID</Text>
            <Text
              style={styles.inconsistencyValue}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {item.sku_id}
            </Text>
            <Text style={styles.inconsistencyLabel}>Location ID</Text>
            <Text
              style={styles.inconsistencyValue}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {item.location_id}
            </Text>
            <View style={styles.inconsistencyBalances}>
              <View style={styles.balanceItem}>
                <Text style={styles.balanceLabel}>Stored</Text>
                <Text style={styles.balanceValue}>{item.stored_balance}</Text>
              </View>
              <View style={styles.balanceSeparator} />
              <View style={styles.balanceItem}>
                <Text style={styles.balanceLabel}>Computed</Text>
                <Text style={styles.balanceValue}>{item.computed_balance}</Text>
              </View>
              <View style={styles.balanceSeparator} />
              <View style={styles.balanceItem}>
                <Text style={styles.balanceLabel}>Delta</Text>
                <Text
                  style={[
                    styles.balanceValue,
                    item.delta > 0 ? styles.deltaPositive : styles.deltaNegative,
                  ]}
                >
                  {item.delta > 0 ? '+' : ''}
                  {isNaN(item.delta) ? 'N/A' : item.delta}
                </Text>
              </View>
            </View>
          </View>
        ))}
      </View>
    );
  };

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Settings</Text>

      {/* ── Team management section ── */}
      <Text style={styles.sectionHeader}>Team</Text>

      <View style={styles.card}>
        <TouchableOpacity
          style={styles.menuRow}
          onPress={() => router.push('/(app)/settings/team')}
          accessibilityRole="button"
          accessibilityLabel="Manage team members"
        >
          <View style={styles.menuRowContent}>
            <Text style={styles.menuRowTitle}>Team Members</Text>
            <Text style={styles.menuRowSubtitle}>View and manage your team</Text>
          </View>
          <Text style={styles.menuRowChevron}>›</Text>
        </TouchableOpacity>

        {isOwner && (
          <>
            <View style={styles.rowDivider} />
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => router.push('/(app)/settings/invite')}
              accessibilityRole="button"
              accessibilityLabel="Invite a new team member"
            >
              <View style={styles.menuRowContent}>
                <Text style={styles.menuRowTitle}>Invite Team Member</Text>
                <Text style={styles.menuRowSubtitle}>
                  Send an email invitation to a new colleague
                </Text>
              </View>
              <Text style={styles.menuRowChevron}>›</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* ── Owner-only: Ledger consistency check ── */}
      {isOwner && (
        <>
          <Text style={styles.sectionHeader}>Data Integrity</Text>

          <View style={styles.card}>
            <View style={styles.checkSection}>
              <Text style={styles.checkTitle}>Ledger Consistency Check</Text>
              <Text style={styles.checkDescription}>
                Verifies that every materialized inventory balance matches the sum
                of its ledger movements. This check reads all SKU balances and is
                best run during off-peak hours.
              </Text>

              <TouchableOpacity
                style={[styles.checkButton, checkLoading && styles.buttonDisabled]}
                onPress={runConsistencyCheck}
                disabled={checkLoading}
                accessibilityRole="button"
                accessibilityLabel="Run ledger consistency check"
              >
                {checkLoading ? (
                  <ActivityIndicator color="#ffffff" size="small" />
                ) : (
                  <Text style={styles.checkButtonText}>
                    Run Consistency Check
                  </Text>
                )}
              </TouchableOpacity>

              {checkLoading && (
                <Text
                  style={styles.checkLoadingHint}
                  accessibilityLiveRegion="polite"
                >
                  Checking all inventory balances…
                </Text>
              )}

              {/* Error state */}
              {checkError && !checkLoading && (
                <View
                  style={styles.errorBanner}
                  accessibilityLiveRegion="assertive"
                  accessibilityRole="alert"
                >
                  <Text style={styles.errorText}>{checkError}</Text>
                </View>
              )}

              {/* Result */}
              {!checkLoading && renderCheckResult()}
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  container: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },

  // ── Headings ──
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#0f172a',
    paddingTop: 20,
    paddingBottom: 12,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 20,
    marginBottom: 8,
    paddingHorizontal: 4,
  },

  // ── Card ──
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },

  // ── Menu rows ──
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  menuRowContent: {
    flex: 1,
  },
  menuRowTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1e293b',
    marginBottom: 2,
  },
  menuRowSubtitle: {
    fontSize: 13,
    color: '#64748b',
  },
  menuRowChevron: {
    fontSize: 20,
    color: '#cbd5e1',
    marginLeft: 8,
  },
  rowDivider: {
    height: 1,
    backgroundColor: '#e2e8f0',
    marginHorizontal: 16,
  },

  // ── Check section ──
  checkSection: {
    padding: 16,
  },
  checkTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: 6,
  },
  checkDescription: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 19,
    marginBottom: 16,
  },
  checkButton: {
    height: 46,
    backgroundColor: '#2563eb',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  checkLoadingHint: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    marginTop: 10,
  },

  // ── Error banner ──
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fca5a5',
    padding: 12,
    marginTop: 14,
  },
  errorText: {
    fontSize: 13,
    color: '#991b1b',
    lineHeight: 18,
  },

  // ── Result — OK ──
  resultBannerOk: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#86efac',
    padding: 12,
    marginTop: 14,
    gap: 8,
  },
  resultIconOk: {
    fontSize: 16,
    color: '#16a34a',
    fontWeight: '700',
  },
  resultTextOk: {
    flex: 1,
    fontSize: 14,
    color: '#166534',
    fontWeight: '500',
    lineHeight: 20,
  },

  // ── Result — inconsistencies found ──
  resultBannerWarn: {
    backgroundColor: '#fffbeb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fcd34d',
    padding: 12,
    marginTop: 14,
  },
  resultTitleWarn: {
    fontSize: 14,
    fontWeight: '700',
    color: '#92400e',
    marginBottom: 12,
  },
  inconsistencyRow: {
    marginTop: 4,
  },
  inconsistencyDivider: {
    height: 1,
    backgroundColor: '#fde68a',
    marginVertical: 10,
  },
  inconsistencyLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#b45309',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  inconsistencyValue: {
    fontSize: 12,
    color: '#78350f',
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  inconsistencyBalances: {
    flexDirection: 'row',
    backgroundColor: '#fef3c7',
    borderRadius: 8,
    padding: 10,
  },
  balanceItem: {
    flex: 1,
    alignItems: 'center',
  },
  balanceLabel: {
    fontSize: 11,
    color: '#b45309',
    fontWeight: '600',
    marginBottom: 2,
  },
  balanceValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#78350f',
  },
  balanceSeparator: {
    width: 1,
    backgroundColor: '#fcd34d',
    marginHorizontal: 8,
  },
  deltaPositive: {
    color: '#15803d',
  },
  deltaNegative: {
    color: '#b91c1c',
  },
});
