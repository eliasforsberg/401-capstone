/**
 * log-audit-event Edge Function
 *
 * Inserts a row into the `audit_log` table. Called by:
 *   - The mobile client's useErrorHandler hook when a 403 Forbidden is received
 *   - Other Edge Functions for auth/inventory audit logging middleware
 *
 * REQUIRED ENVIRONMENT VARIABLES (auto-set in Supabase hosted env):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * REQUEST
 *   POST /functions/v1/log-audit-event
 *   Authorization: Bearer <access_token>
 *   Content-Type: application/json
 *   Body: {
 *     event_type:   string  — must be one of the allowed audit event types
 *     table_name?:  string  — optional: the table affected by the event
 *     record_id?:   string  — optional: UUID of the specific record
 *     details?:     object  — optional: additional context as free-form JSON
 *   }
 *
 * RESPONSES
 *   200  { log_id: string }
 *   400  { error: string }  — invalid event_type or malformed body
 *   401  { error: string }  — missing or invalid JWT
 *   500  { error: string }  — internal error
 *
 * Requirements: 15.4
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_EVENT_TYPES = [
  "auth.sign_in",
  "auth.sign_out",
  "auth.invite",
  "auth.remove_user",
  "permission_denied",
  "inventory.movement",
  "adjustment.created",
  "adjustment.approved",
  "adjustment.rejected",
  "po.created",
  "po.submitted",
  "po.cancelled",
  "count.started",
  "count.completed",
  "count.cancelled",
] as const;

type AuditEventType = typeof ALLOWED_EVENT_TYPES[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequestBody {
  event_type: string;
  table_name?: string;
  record_id?: string;
  details?: Record<string, unknown>;
}

interface UserRoleRow {
  business_id: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isAllowedEventType(value: unknown): value is AuditEventType {
  return typeof value === "string" && ALLOWED_EVENT_TYPES.includes(value as AuditEventType);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── 1. Parse request body ────────────────────────────────────────────────
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { event_type, table_name, record_id, details } = body;

  if (!isAllowedEventType(event_type)) {
    return json(
      { error: `event_type must be one of: ${ALLOWED_EVENT_TYPES.join(", ")}` },
      400,
    );
  }

  // ── 2. Validate caller JWT ───────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error("log-audit-event: missing required env vars");
    return json({ error: "Server configuration error" }, 500);
  }

  // Anon-key client to verify the caller's JWT
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user: caller },
    error: authError,
  } = await callerClient.auth.getUser();

  if (authError || !caller) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Service-role client for privileged DB writes
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 3. Resolve caller's business_id ──────────────────────────────────────
  const { data: roleRow, error: roleError } = await adminClient
    .from("user_roles")
    .select("business_id")
    .eq("user_id", caller.id)
    .maybeSingle<UserRoleRow>();

  if (roleError) {
    console.error("log-audit-event: error querying user_roles:", roleError.message);
    return json({ error: "Internal server error" }, 500);
  }

  // business_id may be null for service-role callers or unregistered users —
  // still allow the log insert so auth failures are always captured.
  const business_id = roleRow?.business_id ?? null;

  // ── 4. Extract client IP from request headers ────────────────────────────
  const ip_address =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null;

  // ── 5. Insert audit log row ──────────────────────────────────────────────
  const { data: logRow, error: insertError } = await adminClient
    .from("audit_log")
    .insert({
      business_id,
      user_id: caller.id,
      event_type,
      table_name: table_name ?? null,
      record_id: record_id ?? null,
      details: details ?? null,
      ip_address,
    })
    .select("log_id")
    .single();

  if (insertError) {
    console.error("log-audit-event: error inserting audit_log:", insertError.message);
    return json({ error: "Failed to write audit log entry" }, 500);
  }

  return json({ log_id: logRow.log_id }, 200);
});
