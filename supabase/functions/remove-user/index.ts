/**
 * remove-user Edge Function
 *
 * Allows an Owner to remove a team member from their business.
 *
 * SECURITY MODEL:
 *   - Caller must supply a valid Bearer JWT (Supabase Auth).
 *   - Caller's role is verified server-side against user_roles; the JWT claim
 *     alone is not trusted for the authorization decision so that a stale token
 *     cannot be replayed after a role change.
 *   - Only role = 'owner' may invoke this endpoint (→ 403 otherwise).
 *   - Self-removal is blocked (→ 400).
 *   - On success the user_roles row is deleted and all Supabase Auth sessions
 *     for that user are revoked via admin.signOut(..., 'others').
 *
 * REQUEST
 *   POST /functions/v1/remove-user
 *   Authorization: Bearer <access_token>
 *   Content-Type: application/json
 *   Body: { "user_id": "<uuid of the user to remove>" }
 *
 * RESPONSES
 *   200 { "message": "User removed successfully" }
 *   400 { "error": "..." }   — missing/invalid body, self-removal
 *   401 { "error": "..." }   — missing or invalid JWT
 *   403 { "error": "..." }   — caller is not an owner
 *   500 { "error": "..." }   — unexpected server error
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RemoveUserBody {
  user_id: string;
}

interface UserRoleRow {
  business_id: string;
  role: "owner" | "staff" | "purchasing" | "accountant";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // Only accept POST requests
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ------------------------------------------------------------------
  // 1. Extract and validate the caller's JWT
  // ------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization") ?? "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  // ------------------------------------------------------------------
  // 2. Build Supabase clients
  // ------------------------------------------------------------------
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("remove-user: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: "Server configuration error" }, 500);
  }

  // Anon-level client used only to verify the caller's JWT
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const callerClient = createClient(supabaseUrl, anonKey ?? serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  // Service-role client for privileged DB writes and Auth admin operations
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ------------------------------------------------------------------
  // 3. Verify caller identity
  // ------------------------------------------------------------------
  const {
    data: { user: callerUser },
    error: userError,
  } = await callerClient.auth.getUser(accessToken);

  if (userError || !callerUser) {
    return json({ error: "Unauthorized — invalid or expired token" }, 401);
  }

  const callerId = callerUser.id;

  // ------------------------------------------------------------------
  // 4. Parse and validate request body
  // ------------------------------------------------------------------
  let body: RemoveUserBody;
  try {
    body = (await req.json()) as RemoveUserBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const targetUserId = body?.user_id?.trim();
  if (!targetUserId) {
    return json({ error: "Missing required field: user_id" }, 400);
  }

  // Block self-removal
  if (callerId === targetUserId) {
    return json({ error: "You cannot remove yourself from the business" }, 400);
  }

  // ------------------------------------------------------------------
  // 5. Verify caller is an owner (server-side role check)
  //    We query with the service-role client to bypass RLS, ensuring the
  //    check always reflects the current state of user_roles.
  // ------------------------------------------------------------------
  const { data: callerRole, error: callerRoleError } = await adminClient
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", callerId)
    .maybeSingle<UserRoleRow>();

  if (callerRoleError) {
    console.error("remove-user: error fetching caller role:", callerRoleError.message);
    return json({ error: "Internal server error" }, 500);
  }

  if (!callerRole) {
    return json({ error: "Caller has no role in any business" }, 403);
  }

  if (callerRole.role !== "owner") {
    return json({ error: "Forbidden — only owners can remove team members" }, 403);
  }

  const businessId = callerRole.business_id;

  // ------------------------------------------------------------------
  // 6. Verify the target user belongs to the same business
  // ------------------------------------------------------------------
  const { data: targetRole, error: targetRoleError } = await adminClient
    .from("user_roles")
    .select("user_role_id")
    .eq("user_id", targetUserId)
    .eq("business_id", businessId)
    .maybeSingle<{ user_role_id: string }>();

  if (targetRoleError) {
    console.error("remove-user: error fetching target role:", targetRoleError.message);
    return json({ error: "Internal server error" }, 500);
  }

  if (!targetRole) {
    return json(
      { error: "Target user is not a member of your business" },
      400,
    );
  }

  // ------------------------------------------------------------------
  // 7. Delete the user_roles row for (user_id, business_id)
  // ------------------------------------------------------------------
  const { error: deleteError } = await adminClient
    .from("user_roles")
    .delete()
    .eq("user_id", targetUserId)
    .eq("business_id", businessId);

  if (deleteError) {
    console.error("remove-user: error deleting user_roles row:", deleteError.message);
    return json({ error: "Failed to remove user from business" }, 500);
  }

  // ------------------------------------------------------------------
  // 8. Revoke all active sessions for the removed user (req 9.6)
  //    'others' scope signs out all sessions for this user globally.
  // ------------------------------------------------------------------
  const { error: signOutError } = await adminClient.auth.admin.signOut(
    targetUserId,
    "others",
  );

  if (signOutError) {
    // Log but don't fail the request — the user_roles row is already gone,
    // so the next token refresh will result in a 401 (no user_roles entry).
    console.warn(
      "remove-user: signOut warning (non-fatal):",
      signOutError.message,
    );
  }

  return json({ message: "User removed successfully" }, 200);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
