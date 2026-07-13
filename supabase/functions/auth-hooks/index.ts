/**
 * auth-hooks Edge Function — Custom Access Token Hook
 *
 * HOW TO REGISTER IN SUPABASE DASHBOARD:
 * 1. Go to Supabase Dashboard → Authentication → Hooks
 * 2. Under "Customize Access Token (JWT) Claims", click "Add hook"
 * 3. Select "Supabase Edge Functions" as the hook type
 * 4. Choose this function: "auth-hooks"
 * 5. Save. From that point on, every new JWT issued on sign-in or token
 *    refresh will have `business_id` and `role` injected as top-level claims.
 *
 * REQUIRED ENVIRONMENT VARIABLES (set in Supabase Dashboard → Edge Functions → Secrets):
 *   SUPABASE_URL              — Your project URL (auto-set in hosted env)
 *   SUPABASE_SERVICE_ROLE_KEY — Service role key (auto-set in hosted env)
 *
 * REQUEST FORMAT (sent by Supabase Auth):
 *   POST /auth-hooks
 *   Body: {
 *     user_id: string,
 *     claims: Record<string, unknown>   // existing JWT payload
 *   }
 *
 * RESPONSE FORMAT:
 *   200 OK  → { claims: Record<string, unknown> }   // mutated claims
 *   401     → { error: string }                     // unregistered user
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthHookRequestBody {
  user_id: string;
  claims: Record<string, unknown>;
}

interface UserRoleRow {
  business_id: string;
  role: "owner" | "staff" | "purchasing" | "accountant";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // Supabase Auth hooks always call via POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: AuthHookRequestBody;
  try {
    body = (await req.json()) as AuthHookRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { user_id, claims } = body;

  if (!user_id) {
    return new Response(JSON.stringify({ error: "Missing user_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Build a service-role Supabase client so we can query user_roles without
  // RLS restrictions (the user does not yet have a JWT with claims at this
  // point in the auth flow).
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("auth-hooks: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      // Prevent the client from trying to persist a session server-side
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  // Query the user_roles table for this user's business association and role.
  // The UNIQUE (user_id, business_id) constraint means at most one row per
  // business; MVP supports a single business per user.
  const { data, error } = await supabase
    .from("user_roles")
    .select("business_id, role")
    .eq("user_id", user_id)
    .maybeSingle<UserRoleRow>();

  if (error) {
    console.error("auth-hooks: error querying user_roles:", error.message);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // If there is no user_roles entry the user is not yet registered in any
  // business — reject authentication with 401 per Requirements 9.1 / 12.2.
  if (!data) {
    console.warn(`auth-hooks: user ${user_id} has no user_roles entry — rejecting`);
    return new Response(
      JSON.stringify({ error: "User is not registered in any business" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // Inject business_id and role as top-level JWT claims so that Supabase RLS
  // policies can reference them via:
  //   (auth.jwt() ->> 'business_id')::uuid
  //   (auth.jwt() ->> 'role')
  const enrichedClaims: Record<string, unknown> = {
    ...claims,
    business_id: data.business_id,
    role: data.role,
  };

  return new Response(
    JSON.stringify({ claims: enrichedClaims }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});
