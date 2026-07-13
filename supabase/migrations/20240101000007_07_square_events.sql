-- Migration: 07_square_events
-- Creates the square_sync_events table for Square webhook ingestion and idempotency

CREATE TABLE square_sync_events (
  event_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(business_id),
  square_event_type   TEXT NOT NULL,
  square_event_id     TEXT NOT NULL,
  payload             JSONB,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','success','failed','unmatched','duplicate')),
  retry_count         INTEGER NOT NULL DEFAULT 0,
  processed_at        TIMESTAMPTZ,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (square_event_id)
);

-- Explicit unique index for Square event idempotency lookups (fast dedup on ingestion)
CREATE UNIQUE INDEX idx_square_event_id
  ON square_sync_events (square_event_id);
