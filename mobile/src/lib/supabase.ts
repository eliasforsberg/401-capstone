import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/lib/constants';

// ---------------------------------------------------------------------------
// Storage adapter for Supabase Auth session persistence.
// react-native-mmkv is a native-only module — importing it on web crashes the
// bundle. We lazily require it only on native platforms and fall back to the
// default (localStorage-based) storage on web.
// On native, if MMKV fails (e.g. bridgeless mode incompatibility), we fall
// back to an in-memory store so the app doesn't crash.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let storageAdapter: any = undefined;

if (Platform.OS !== 'web') {
  try {
    // Dynamic require keeps the MMKV import out of the web bundle entirely.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
    const mmkv = new MMKV({ id: 'supabase-auth' });

    storageAdapter = {
      getItem: (key: string): string | null => mmkv.getString(key) ?? null,
      setItem: (key: string, value: string): void => mmkv.set(key, value),
      removeItem: (key: string): void => mmkv.delete(key),
    };
  } catch (e) {
    // MMKV JSI unavailable (bridgeless mode, remote debugger, etc.)
    // Fall back to in-memory storage — sessions won't persist across restarts.
    console.warn('[supabase] MMKV unavailable, using in-memory storage:', e);
    const memStore = new Map<string, string>();
    storageAdapter = {
      getItem: (key: string): string | null => memStore.get(key) ?? null,
      setItem: (key: string, value: string): void => { memStore.set(key, value); },
      removeItem: (key: string): void => { memStore.delete(key); },
    };
  }
}

// ---------------------------------------------------------------------------
// Supabase client singleton
// ---------------------------------------------------------------------------

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: storageAdapter, // undefined on web → Supabase uses localStorage
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web', // enable URL fragment auth on web
  },
});
