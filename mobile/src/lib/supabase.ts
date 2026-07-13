import { createClient } from '@supabase/supabase-js';
import { MMKV } from 'react-native-mmkv';

import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/lib/constants';

// ---------------------------------------------------------------------------
// MMKV storage adapter for Supabase Auth session persistence.
// react-native-mmkv is synchronous, so we wrap it in the async interface
// that Supabase JS expects.
// ---------------------------------------------------------------------------

const mmkv = new MMKV({ id: 'supabase-auth' });

const mmkvStorageAdapter = {
  getItem: (key: string): string | null => {
    return mmkv.getString(key) ?? null;
  },
  setItem: (key: string, value: string): void => {
    mmkv.set(key, value);
  },
  removeItem: (key: string): void => {
    mmkv.delete(key);
  },
};

// ---------------------------------------------------------------------------
// Supabase client singleton
// ---------------------------------------------------------------------------

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: mmkvStorageAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false, // not a web app — disable URL fragment detection
  },
});
