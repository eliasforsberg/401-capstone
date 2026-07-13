/**
 * invite-user Edge Function
 *
 * Allows an `owner` to invite a new user to their business by email.
 * The invited user receives a Supabase Auth magic-link email. On first
 * sign-in the `auth-hooks` function will inject `business_id` and `role`
 * into their JWT using the metadata stored on the Auth user record.
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *   SUPABASE_URL              — auto-set in hosted env
 *   SUPABASE_ANON_KEY         — auto-set in hosted env
 *   SUPABASE_SERVICE_ROLE_KEY — auto-set in hosted env
 *
 * REQUEST (POST, authenticated):
 *   Authorization: Bearer <user-jwt>
 *   Body: { email: string, role: "staff" | "purchasing" | "accountant" }
 *
 * RESPONSES:
 *   200  { success: true }
 *   400  { error: "…" }   — missing / invalid fields
 *   401  { error: "…" }   — missing or invalid JWT
 *   403  { error: "…" }   — caller is not an owner
 *   500  { error: "…" }   — server / Supabase error
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InvitableRole = "staff" | "purchasing" | "accountant";

interface RequestBody {
  email: string;
  role: InvitableRole;
}

interface UserRoleRow {
  business_id: string;
  role: "owner" | "staff" | "purchasing" | "accountant";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const INVITABLE_ROLES: readonly InvitableRole[] = [
  "staff",
  "purchasing",
  "accountant",
];

function isInvitableRole(value: unknown): value is InvitableRole {
  return typeof value === "string" && INVITABLE_ROLES.includes(value as InvitableRole);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ── 1. Parse and validate the request body ──────────────────────────────
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { email, role } = body;

  if (!email || typeof email !== "string") {
    return jsonResponse({ error: "email is required" }, 400);
  }
  if (!isInvitableRole(role)) {
    return jsonResponse(
      { error: `role must be one of: ${INVITABLE_ROLES.join(", ")}` },
      400,
    );
  }

  // ── 2. Validate the caller's JWT ────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error("invite-user: missing required env vars");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  // Use anon-key client to verify the caller's JWT
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user: caller },
    error: authError,
  } = await callerClient.auth.getUser();

  if (authError || !caller) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // ── 3. Confirm the caller is an owner using the service-role client ─────
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: callerRole, error: roleError } = await adminClient
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", caller.id)
    .maybeSingle<UserRoleRow>();

  if (roleError) {
    console.error("invite-user: error querying user_roles:", roleError.message);
    return jsonResponse({ error: "Internal server error" }, 500);
  }

  if (!callerRole || callerRole.role !== "owner") {
    return jsonResponse(
      { error: "Forbidden: only an owner can invite users" },
      403,
    );
  }

  const businessId = callerRole.business_id;

  // ── 4. Send the invitation email via Auth admin ─────────────────────────
  // Pass business_id and role as user metadata so that auth-hooks can insert
  // the user_roles row when the invited user first signs in.
  const { error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
    email,
    {
      data: {
        business_id: businessId,
        role,
      },
    },
  );

  if (inviteError) {
    console.error("invite-user: inviteUserByEmail error:", inviteError.message);
    return jsonResponse({ error: inviteError.message }, 500);
  }

  return jsonResponse({ success: true }, 200);
});
