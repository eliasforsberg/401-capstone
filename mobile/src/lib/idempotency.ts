/**
 * Idempotency key generation for offline queue actions.
 * Each key is a UUID v4 that is sent to Edge Functions so retried
 * requests are not applied more than once.
 */

/**
 * Generate a UUID v4 idempotency key.
 * Uses `crypto.randomUUID()` when available (React Native Hermes ≥ 0.71),
 * otherwise falls back to a manual RFC 4122-compliant implementation.
 */
export function generateIdempotencyKey(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  // Fallback: manual UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
