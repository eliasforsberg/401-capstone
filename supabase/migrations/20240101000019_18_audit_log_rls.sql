-- Migration: 18_audit_log_rls
-- Row Level Security policies for the audit_log table.
--
-- Rules:
--   - INSERT: service role only (Edge Functions write via service-role key).
--             RLS INSERT policy is set to FALSE so that no user can insert
--             directly — only the service-role client (which bypasses RLS)
--             may write rows.
--   - SELECT: owners can read all audit events for their business.
--             Other roles cannot access audit_log via the API.
--   - UPDATE / DELETE: prohibited via RLS (audit_log is append-only).
--
-- Requirements: 15.4

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- SELECT — owners can read their business's audit feed
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "audit_log_select_owner" ON audit_log;
CREATE POLICY "audit_log_select_owner"
  ON audit_log
  FOR SELECT
  USING (
    business_id = (auth.jwt() ->> 'business_id')::uuid
    AND (auth.jwt() ->> 'role') = 'owner'
  );

-- ---------------------------------------------------------------------------
-- INSERT — blocked via RLS for all JWT-bearing callers.
--          The service-role client (Edge Functions) bypasses RLS entirely.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "audit_log_insert_deny" ON audit_log;
CREATE POLICY "audit_log_insert_deny"
  ON audit_log
  FOR INSERT
  WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- UPDATE — explicitly blocked (append-only)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "audit_log_update_deny" ON audit_log;
CREATE POLICY "audit_log_update_deny"
  ON audit_log
  FOR UPDATE
  USING (false);

-- ---------------------------------------------------------------------------
-- DELETE — explicitly blocked (append-only)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "audit_log_delete_deny" ON audit_log;
CREATE POLICY "audit_log_delete_deny"
  ON audit_log
  FOR DELETE
  USING (false);
