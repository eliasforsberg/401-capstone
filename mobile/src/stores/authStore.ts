import type { Session, User } from '@supabase/supabase-js';
import { create } from 'zustand';

import { supabase } from '@/lib/supabase';
import type { UserRole } from '@/types';

// ---------------------------------------------------------------------------
// JWT claim extraction
// ---------------------------------------------------------------------------

/**
 * Decode the payload section of a JWT without verifying the signature.
 * Verification is performed server-side by Supabase; the client only reads
 * the claims that were injected by the `auth-hooks` Edge Function.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const base64Payload = token.split('.')[1];
    if (!base64Payload) return {};

    // Normalise Base64url → Base64 and pad to a multiple of 4
    const normalized = base64Payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractClaims(accessToken: string): {
  businessId: string | null;
  role: UserRole | null;
} {
  const payload = decodeJwtPayload(accessToken);
  const businessId =
    typeof payload['business_id'] === 'string' ? payload['business_id'] : null;
  const rawRole = payload['role'];
  const role: UserRole | null =
    rawRole === 'owner' ||
    rawRole === 'staff' ||
    rawRole === 'purchasing' ||
    rawRole === 'accountant'
      ? rawRole
      : null;

  return { businessId, role };
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

interface AuthState {
  session: Session | null;
  user: User | null;
  businessId: string | null;
  role: UserRole | null;
  isLoading: boolean;
}

interface AuthActions {
  /**
   * Update auth state from a session object.
   * Decodes the access token to populate `businessId` and `role` from
   * the custom JWT claims injected by the `auth-hooks` Edge Function.
   */
  setSession: (session: Session | null) => void;
  /** Sign out and clear all auth state. */
  signOut: () => Promise<void>;
  /**
   * Call once on app startup.
   * Restores an existing session from MMKV storage and subscribes to
   * Supabase Auth state changes for the lifetime of the app.
   */
  initialize: () => Promise<void>;
}

type AuthStore = AuthState & AuthActions;

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useAuthStore = create<AuthStore>((set) => ({
  // ---- initial state ----
  session: null,
  user: null,
  businessId: null,
  role: null,
  isLoading: true,

  // ---- actions ----

  setSession: (session) => {
    if (session === null) {
      set({ session: null, user: null, businessId: null, role: null });
      return;
    }

    const { businessId, role } = extractClaims(session.access_token);
    set({ session, user: session.user, businessId, role });
  },

  signOut: async () => {
    await supabase.auth.signOut();
    // onAuthStateChange will fire with event='SIGNED_OUT', which calls
    // setSession(null) and clears state. We do it here as well for
    // immediate UI responsiveness.
    set({ session: null, user: null, businessId: null, role: null });
  },

  initialize: async () => {
    set({ isLoading: true });

    // Restore session persisted in MMKV by the Supabase client
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session) {
      const { businessId, role } = extractClaims(session.access_token);
      set({ session, user: session.user, businessId, role });
    }

    set({ isLoading: false });

    // Subscribe to future auth state changes (sign-in, token refresh, sign-out)
    supabase.auth.onAuthStateChange((_event, newSession) => {
      if (newSession) {
        const { businessId, role } = extractClaims(newSession.access_token);
        set({
          session: newSession,
          user: newSession.user,
          businessId,
          role,
        });
      } else {
        set({ session: null, user: null, businessId: null, role: null });
      }
    });
  },
}));
