/**
 * Count index screen — choose count type or resume an in-progress session.
 *
 * Flow:
 *   1. On mount, query `stock_count_sessions` for any `in_progress` session
 *      belonging to this business / location.
 *   2. If one exists → show a prominent "Resume" banner.
 *   3. If none → show Cycle Count and Full Audit option cards.
 *   4. On option select → call `start-count-session` Edge Function →
 *      navigate to `/(app)/count/[sessionId]`.
 *
 * Requirements: 6.1, 6.2
 */

import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { generateIdempotencyKey } from '@/lib/idempotency';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { CountSessionStatus, CountType } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CountSession {
  session_id: string;
  count_type: CountType;
  started_at: string;
  status: CountSessionStatus;
  total_lines: number;
  submitted_lines: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function CountIndexScreen() {
  const businessId = useAuthStore((s) => s.businessId);

  const [inProgressSession, setInProgressSession] = useState<CountSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState<CountType | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- fetch in-progress session ----

  const fetchSession = useCallback(async () => {
    if (!businessId) return;
    setError(null);

    const { data, error: fetchError } = await supabase
      .from('stock_count_sessions')
      .select(
        `
        session_id,
        count_type,
        started_at,
        status,
        stock_count_lines ( line_id, submitted_quantity )
        `
      )
      .eq('business_id', businessId)
      .eq('status', 'in_progress')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      setError('Failed to check for in-progress sessions.');
      return;
    }

    if (!data) {
      setInProgressSession(null);
      return;
    }

    const lines = Array.isArray(data.stock_count_lines)
      ? (data.stock_count_lines as Array<{ line_id: string; submitted_quantity: number | null }>)
      : [];

    const session: CountSession = {
      session_id: data.session_id,
      count_type: data.count_type as CountType,
      started_at: data.started_at,
      status: data.status as CountSessionStatus,
      total_lines: lines.length,
      submitted_lines: lines.filter((l) => l.submitted_quantity != null).length,
    };
    setInProgressSession(session);
  }, [businessId]);

  useEffect(() => {
    setLoading(true);
    fetchSession().finally(() => setLoading(false));
  }, [fetchSession]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchSession();
    setRefreshing(false);
  }, [fetchSession]);

  // ---- start a new session ----

  const handleStartSession = useCallback(
    async (countType: CountType) => {
      if (!businessId) return;

      // Guard: don't start if a session is already in progress
      if (inProgressSession) {
        Alert.alert(
          'Session In Progress',
          'Please complete or cancel your current count session before starting a new one.',
          [
            {
              text: 'Resume Session',
              onPress: () =>
                router.push(`/(app)/count/${inProgressSession.session_id}`),
            },
            { text: 'OK', style: 'cancel' },
          ]
        );
        return;
      }

      setStarting(countType);
      setError(null);

      try {
        const { data, error: fnError } = await supabase.functions.invoke(
          'start-count-session',
          {
            body: {
              business_id: businessId,
              count_type: countType,
              idempotency_key: generateIdempotencyKey(),
            },
          }
        );

        if (fnError) {
          throw new Error(fnError.message ?? 'Failed to start count session');
        }

        const sessionId: string =
          data?.session_id ?? data?.data?.session_id;

        if (!sessionId) {
          throw new Error('No session ID returned from server.');
        }

        router.push(`/(app)/count/${sessionId}`);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Could not start count session.';
        setError(message);
        Alert.alert('Error', message);
      } finally {
        setStarting(null);
      }
    },
    [businessId, inProgressSession]
  );

  // ---- render ----

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Stock Count</Text>
        <Text style={styles.subtitle}>
          Reconcile physical stock against system balances
        </Text>
      </View>

      {/* Error banner */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* In-progress session banner */}
      {inProgressSession && (
        <View style={styles.inProgressBanner}>
          <View style={styles.inProgressBadge}>
            <Text style={styles.inProgressBadgeText}>IN PROGRESS</Text>
          </View>
          <Text style={styles.inProgressTitle}>
            {inProgressSession.count_type === 'cycle_count'
              ? 'Cycle Count'
              : 'Full Audit'}{' '}
            Session
          </Text>
          <Text style={styles.inProgressMeta}>
            Started {formatDate(inProgressSession.started_at)} ·{' '}
            {inProgressSession.submitted_lines} of{' '}
            {inProgressSession.total_lines} SKUs counted
          </Text>
          <TouchableOpacity
            style={styles.resumeButton}
            onPress={() =>
              router.push(`/(app)/count/${inProgressSession.session_id}`)
            }
            activeOpacity={0.8}
          >
            <Text style={styles.resumeButtonText}>Resume Session</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Count type options */}
      {!inProgressSession && (
        <View style={styles.optionsSection}>
          <Text style={styles.sectionLabel}>START A COUNT</Text>

          {/* Cycle Count card */}
          <TouchableOpacity
            style={styles.optionCard}
            onPress={() => handleStartSession('cycle_count')}
            disabled={starting !== null}
            activeOpacity={0.7}
          >
            <View style={styles.optionIcon}>
              <Text style={styles.optionIconText}>🔄</Text>
            </View>
            <View style={styles.optionContent}>
              <Text style={styles.optionTitle}>Cycle Count</Text>
              <Text style={styles.optionDescription}>
                Count a targeted subset of SKUs. Faster and less disruptive —
                ideal for regular spot-checks.
              </Text>
            </View>
            {starting === 'cycle_count' ? (
              <ActivityIndicator color="#6366F1" />
            ) : (
              <Text style={styles.optionChevron}>›</Text>
            )}
          </TouchableOpacity>

          {/* Full Audit card */}
          <TouchableOpacity
            style={styles.optionCard}
            onPress={() => handleStartSession('full_audit')}
            disabled={starting !== null}
            activeOpacity={0.7}
          >
            <View style={styles.optionIcon}>
              <Text style={styles.optionIconText}>📋</Text>
            </View>
            <View style={styles.optionContent}>
              <Text style={styles.optionTitle}>Full Audit</Text>
              <Text style={styles.optionDescription}>
                Count every active SKU at this location. Use for period-end
                or annual stock takes.
              </Text>
            </View>
            {starting === 'full_audit' ? (
              <ActivityIndicator color="#6366F1" />
            ) : (
              <Text style={styles.optionChevron}>›</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* If in progress, offer secondary start-new option */}
      {inProgressSession && (
        <View style={styles.newSessionSection}>
          <Text style={styles.newSessionNote}>
            Complete or cancel the current session to start a new count.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  scrollContent: {
    paddingBottom: 48,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F9FAFB',
  },

  // ---- header ----
  header: {
    backgroundColor: '#FFFFFF',
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 20,
  },

  // ---- error banner ----
  errorBanner: {
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorText: {
    color: '#991B1B',
    fontSize: 14,
  },

  // ---- in-progress banner ----
  inProgressBanner: {
    margin: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#A5B4FC',
    shadowColor: '#6366F1',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  inProgressBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#EEF2FF',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 10,
  },
  inProgressBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6366F1',
    letterSpacing: 0.8,
  },
  inProgressTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  inProgressMeta: {
    fontSize: 13,
    color: '#6B7280',
    marginBottom: 16,
  },
  resumeButton: {
    backgroundColor: '#6366F1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  resumeButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },

  // ---- option cards ----
  optionsSection: {
    padding: 16,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9CA3AF',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  optionIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  optionIconText: {
    fontSize: 22,
  },
  optionContent: {
    flex: 1,
    marginRight: 10,
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  optionDescription: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
  },
  optionChevron: {
    fontSize: 22,
    color: '#9CA3AF',
    fontWeight: '300',
  },

  // ---- secondary note ----
  newSessionSection: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  newSessionNote: {
    fontSize: 13,
    color: '#9CA3AF',
    textAlign: 'center',
    fontStyle: 'italic',
  },
});
