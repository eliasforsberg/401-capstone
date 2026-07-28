-- Migration: 09_offline_queue_log
-- Creates the offline_queue_log table for server-side idempotency of offline actions

CREATE TABLE offline_queue_log (
  log_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(business_id),
  idempotency_key     TEXT NOT NULL,
  action_type         TEXT NOT NULL,
  payload             JSONB,
  status              TEXT NOT NULL CHECK (status IN ('processed','failed','conflict')),
  conflict_details    JSONB,
  processed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);
