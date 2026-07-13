/**
 * Team Management screen — Settings > Team
 *
 * Visible to all authenticated users, but only Owners see "Remove" buttons.
 * Non-owners see a read-only list of team members with their roles.
 *
 * Data fetching:
 *   - Queries `user_roles` joined to `user_profiles` for the current business.
 *   - Uses TanStack Query (useQuery) for caching and background refetch.
 *
 * Remove flow (owner only):
 *   1. Tap "Remove" next to a member.
 *   2. Confirm in an Alert dialog.
 *   3. Invoke `remove-user` Edge Function.
 *   4. Invalidate the team query so the list refreshes.
 */

import { useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';
import type { UserRole } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamMember {
  userId: string;
  displayName: string | null;
  email: string | null;
  role: UserRole;
}

// Raw shape returned by the Supabase queries
interface UserRoleRow {
  user_id: string;
  role: UserRole;
}

interface UserProfileRow {
  user_id: string;
  display_name: string | null;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

const TEAM_QUERY_KEY = (businessId: string) => ['team', businessId] as const;

async function fetchTeamMembers(businessId: string): Promise<TeamMember[]> {
  // Step 1: fetch all user_roles for this business
  const { data: roles, error: rolesError } = await supabase
    .from('user_roles')
    .select('user_id, role')
    .eq('business_id', businessId)
    .order('role', { ascending: true });

  if (rolesError) {
    throw new Error(rolesError.message);
  }
  if (!roles || roles.length === 0) {
    return [];
  }

  const userIds = (roles as UserRoleRow[]).map((r) => r.user_id);

  // Step 2: fetch display_names from user_profiles for those users.
  // user_profiles.user_id is a FK to auth.users, shared with user_roles.user_id,
  // but PostgREST cannot auto-join two tables that only share a common FK target
  // (auth.users) without an explicit FK between them — so we do two queries.
  const { data: profiles, error: profilesError } = await supabase
    .from('user_profiles')
    .select('user_id, display_name')
    .in('user_id', userIds);

  if (profilesError) {
    throw new Error(profilesError.message);
  }

  const profileMap = new Map<string, string | null>(
    (profiles as UserProfileRow[]).map((p) => [p.user_id, p.display_name]),
  );

  return (roles as UserRoleRow[]).map((row) => ({
    userId: row.user_id,
    displayName: profileMap.get(row.user_id) ?? null,
    email: null, // not available from anon client without admin API
    role: row.role,
  }));
}

async function removeTeamMember(userId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('remove-user', {
    body: { user_id: userId },
  });

  if (error) {
    throw new Error(error.message ?? 'Failed to remove user');
  }
}

// ---------------------------------------------------------------------------
// Role display helpers
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Owner',
  staff: 'Staff',
  purchasing: 'Purchasing',
  accountant: 'Accountant',
};

const ROLE_COLORS: Record<UserRole, string> = {
  owner: '#6366f1',    // indigo
  staff: '#10b981',   // emerald
  purchasing: '#f59e0b', // amber
  accountant: '#64748b', // slate
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TeamScreen() {
  const { businessId, role: callerRole, user } = useAuthStore();
  const queryClient = useQueryClient();

  const isOwner = callerRole === 'owner';

  // ---- Data fetching ----

  const {
    data: members = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: TEAM_QUERY_KEY(businessId ?? ''),
    queryFn: () => fetchTeamMembers(businessId!),
    enabled: !!businessId,
  });

  // ---- Remove mutation ----

  const removeMutation = useMutation({
    mutationFn: removeTeamMember,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: TEAM_QUERY_KEY(businessId ?? ''),
      });
    },
    onError: (err: Error) => {
      Alert.alert('Error', err.message || 'Could not remove team member.');
    },
  });

  // ---- Remove confirmation ----

  const handleRemove = useCallback(
    (member: TeamMember) => {
      const name = member.displayName ?? member.email ?? 'this team member';
      Alert.alert(
        'Remove Team Member',
        `Are you sure you want to remove ${name} from the business? Their access will be revoked immediately.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => removeMutation.mutate(member.userId),
          },
        ],
      );
    },
    [removeMutation],
  );

  // ---- Render helpers ----

  const renderMember = useCallback(
    ({ item }: { item: TeamMember }) => {
      const isSelf = item.userId === user?.id;
      const showRemove = isOwner && !isSelf;
      const label = item.displayName ?? item.email ?? 'Unknown user';

      return (
        <View style={styles.row}>
          <View style={styles.rowInfo}>
            <Text style={styles.memberName} numberOfLines={1}>
              {label}
              {isSelf ? ' (you)' : ''}
            </Text>
            <View
              style={[
                styles.roleBadge,
                { backgroundColor: ROLE_COLORS[item.role] + '22' },
              ]}
            >
              <Text
                style={[styles.roleText, { color: ROLE_COLORS[item.role] }]}
              >
                {ROLE_LABELS[item.role]}
              </Text>
            </View>
          </View>

          {showRemove && (
            <TouchableOpacity
              style={styles.removeButton}
              onPress={() => handleRemove(item)}
              disabled={removeMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${label}`}
            >
              <Text style={styles.removeButtonText}>Remove</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    },
    [isOwner, user?.id, handleRemove, removeMutation.isPending],
  );

  // ---- Guard: business not loaded ----

  if (!businessId) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>No business found.</Text>
      </View>
    );
  }

  // ---- Guard: non-owner access denied ----

  if (!isOwner) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Team</Text>

        {isLoading ? (
          <ActivityIndicator style={styles.loader} />
        ) : isError ? (
          <View style={styles.centered}>
            <Text style={styles.errorText}>
              {(error as Error)?.message ?? 'Failed to load team.'}
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.accessNote}>
              You can view team members but only the Owner can manage access.
            </Text>
            <FlatList
              data={members}
              keyExtractor={(m) => m.userId}
              renderItem={renderMember}
              contentContainerStyle={styles.list}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
            />
          </>
        )}
      </View>
    );
  }

  // ---- Owner view ----

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Team</Text>

      {isLoading ? (
        <ActivityIndicator style={styles.loader} />
      ) : isError ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>
            {(error as Error)?.message ?? 'Failed to load team.'}
          </Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : members.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No team members found.</Text>
        </View>
      ) : (
        <FlatList
          data={members}
          keyExtractor={(m) => m.userId}
          renderItem={renderMember}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}

      {removeMutation.isPending && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color="#ffffff" />
          <Text style={styles.loadingOverlayText}>Removing member…</Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0f172a',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  accessNote: {
    fontSize: 13,
    color: '#64748b',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  loader: {
    marginTop: 40,
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  rowInfo: {
    flex: 1,
    marginRight: 12,
  },
  memberName: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1e293b',
    marginBottom: 4,
  },
  roleBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  roleText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  removeButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  removeButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ef4444',
  },
  separator: {
    height: 1,
    backgroundColor: '#e2e8f0',
  },
  errorText: {
    fontSize: 14,
    color: '#ef4444',
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#6366f1',
  },
  retryText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 14,
  },
  loadingOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0f172acc',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    gap: 10,
  },
  loadingOverlayText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '500',
  },
});
