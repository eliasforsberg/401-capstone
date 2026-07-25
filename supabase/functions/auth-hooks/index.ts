/**
 * auth-hooks Edge Function — Custom Access Token Hook
 *
 * Injects `business_id` and `role` into the JWT claims on every sign-in
 * and token refresh by looking up the user_roles table.
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
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  // Query user_roles for this user's business and role
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

  if (!data) {
    console.warn(`auth-hooks: user ${user_id} has no user_roles entry — rejecting`);
    return new Response(
      JSON.stringify({ error: "User is not registered in any business" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // Inject business_id and user_role into JWT claims.
  // IMPORTANT: Do NOT overwrite the top-level "role" claim — Supabase Auth
  // requires it to remain "authenticated". Use "user_role" for app-level role.
  const enrichedClaims: Record<string, unknown> = {
    ...claims,
    business_id: data.business_id,
    user_role: data.role,
  };

  // Fire-and-forget audit log
  try {
    await supabase.from("audit_log").insert({
      user_id,
      business_id: data.business_id,
      event_type: "auth.sign_in",
      details: { role: data.role },
      ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
  } catch (e) {
    console.error("auth-hooks: audit log failed:", e);
  }

  return new Response(
    JSON.stringify({ claims: enrichedClaims }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
