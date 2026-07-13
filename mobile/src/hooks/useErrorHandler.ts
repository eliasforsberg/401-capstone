/**
 * useErrorHandler
 *
 * Returns a `handleError` function that inspects errors and, for 403 Forbidden
 * responses, asynchronously logs a `permission_denied` audit event via the
 * `log-audit-event` Edge Function. The call is fire-and-forget — it does not
 * block the UI or surface its own errors to the user.
 *
 * Usage:
 *   const handleError = useErrorHandler();
 *
 *   try {
 *     await someProtectedOperation();
 *   } catch (err) {
 *     handleError(err, { screen: 'adjust-stock', skuId });
 *   }
 *
 * Requirements: 15.4
 */

import { useCallback } from 'react';

import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Extra context the caller can attach to the audit log entry. */
export type ErrorContext = Record<string, unknown>;

/** An error object that may carry an HTTP status code. */
interface ErrorWithStatus {
  status?: number;
  statusCode?: number;
  code?: number | string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the error represents an HTTP 403 Forbidden response.
 * Handles Supabase JS errors, fetch Response objects, and plain objects with
 * a `status` / `statusCode` field.
 */
function isForbiddenError(error: unknown): boolean {
  if (!error) return false;

  // Plain objects / Supabase error shapes
  const e = error as ErrorWithStatus;
  if (e.status === 403 || e.statusCode === 403) return true;

  // Numeric code stored as a string (e.g., Supabase PostgREST code "42501")
  if (typeof e.code === 'number' && e.code === 403) return true;

  // Some Supabase SDK errors set the HTTP status as a string in message
  if (typeof e.message === 'string' && e.message.includes('403')) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useErrorHandler() {
  const handleError = useCallback(
    (error: unknown, context?: ErrorContext): unknown => {
      if (isForbiddenError(error)) {
        // Fire-and-forget: do not await so this never blocks the UI
        const errorMessage =
          (error as ErrorWithStatus).message ?? 'Permission denied';

        supabase.functions
          .invoke('log-audit-event', {
            body: {
              event_type: 'permission_denied',
              details: {
                error: errorMessage,
                ...context,
              },
            },
          })
          .catch((logErr: unknown) => {
            // Swallow silently — audit logging must never cause secondary errors
            console.warn('useErrorHandler: failed to log audit event', logErr);
          });
      }

      // Always return the original error so callers can display/handle it
      return error;
    },
    [],
  );

  return handleError;
}
