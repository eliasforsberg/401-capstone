/**
 * App-wide constants.
 *
 * Values are read from EXPO_PUBLIC_* environment variables at build time.
 * Fallbacks point at the local Supabase stack started by `supabase start`.
 */

export const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';

export const SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
