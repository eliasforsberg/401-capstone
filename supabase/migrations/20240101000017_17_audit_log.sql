-- Migration: 17_audit_log
-- Creates the audit_log table for logging all auth events, permission-denied
-- events, and inventory-affecting operations.
--
-- Requirements: 15.4

-- ---------------------------------------------------------------------------
-- audit_log
-- Append-only log of security and inventory events across the platform.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  log_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID        REFERENCES businesses(business_id) ON DELETE CASCADE,
  user_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type    TEXT        NOT NULL CHECK (event_type IN (
                              'auth.sign_in',
                              'auth.sign_out',
                              'auth.invite',
                              'auth.remove_user',
                              'permission_denied',
                              'inventory.movement',
                              'adjustment.created',
                              'adjustment.approved',
                              'adjustment.rejected',
                              'po.created',
                              'po.submitted',
                              'po.cancelled',
                              'count.started',
                              'count.completed',
                              'count.cancelled'
                            )),
  table_name    TEXT,
  record_id     UUID,
  details       JSONB,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for querying audit events for a business filtered by type and time
CREATE INDEX idx_audit_log_business_event_time
  ON audit_log (business_id, event_type, created_at DESC);

-- Index for the full audit feed (all events for a business, newest first)
CREATE INDEX idx_audit_log_business_time
  ON audit_log (business_id, created_at DESC);
