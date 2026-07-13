/**
 * Shared audit logging helper for Edge Functions.
 *
 * Inserts a row directly into the `audit_log` table using the service-role
 * client. This is intentionally fire-and-forget: audit failures must never
 * block the primary operation. All errors are logged to console only.
 *
 * Requirements: 15.4
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types (must mirror the audit_log CHECK constraint in the migration)
// ---------------------------------------------------------------------------

export type AuditEventType =
  | "auth.sign_in"
  | "auth.sign_out"
  | "auth.invite"
  | "auth.remove_user"
  | "permission_denied"
  | "inventory.movement"
  | "adjustment.created"
  | "adjustment.approved"
  | "adjustment.rejected"
  | "po.created"
  | "po.submitted"
  | "po.cancelled"
  | "count.started"
  | "count.completed"
  | "count.cancelled";

export interface AuditEventParams {
  /** Supabase service-role client — bypasses RLS for the insert */
  adminClient: SupabaseClient;
  /** ID of the authenticated user performing the action */
  user_id: string;
  /** Business the event belongs to (may be null for failed auth events) */
  business_id: string | null;
  /** Canonical event type */
  event_type: AuditEventType;
  /** The table primarily affected by this event (optional) */
  table_name?: string;
  /** UUID of the primary record affected (optional) */
  record_id?: string;
  /** Arbitrary extra context */
  details?: Record<string, unknown>;
  /** Client IP extracted from request headers (optional) */
  ip_address?: string | null;
}

// ---------------------------------------------------------------------------
// logAuditEvent
// ---------------------------------------------------------------------------

/**
 * Writes one row to `audit_log`.
 *
 * This function is intentionally non-throwing: any insert failure is
 * console-logged and swallowed so the calling function can always return
 * its primary response without being blocked by audit concerns.
 */
export async function logAuditEvent(params: AuditEventParams): Promise<void> {
  const {
    adminClient,
    user_id,
    business_id,
    event_type,
    table_name,
    record_id,
    details,
    ip_address,
  } = params;

  const { error } = await adminClient.from("audit_log").insert({
    user_id,
    business_id,
    event_type,
    table_name: table_name ?? null,
    record_id: record_id ?? null,
    details: details ?? null,
    ip_address: ip_address ?? null,
  });

  if (error) {
    // Audit failures must never surface to callers — log only.
    console.error(
      `[audit] Failed to write ${event_type} event for user ${user_id}:`,
      error.message,
    );
  }
}

// ---------------------------------------------------------------------------
// extractIp
// ---------------------------------------------------------------------------

/** Extracts the client IP from standard forwarding headers. */
export function extractIp(req: Request): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null
  );
}
