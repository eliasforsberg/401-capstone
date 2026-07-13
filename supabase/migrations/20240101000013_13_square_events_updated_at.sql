-- Migration: 13_square_events_updated_at
-- Adds updated_at to square_sync_events so the square-webhook-retry function
-- can use it for exponential backoff timing (checking elapsed time since last
-- retry attempt).
--
-- Also adds a trigger to auto-update updated_at on every row update, consistent
-- with how other tables track mutation timestamps.
--
-- Requirements: 3.7 (retry with exponential backoff)

ALTER TABLE square_sync_events
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill existing rows so updated_at = created_at
UPDATE square_sync_events
  SET updated_at = created_at
  WHERE updated_at = now() AND created_at < now();

-- Trigger function to keep updated_at current on every update
CREATE OR REPLACE FUNCTION set_square_sync_events_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_square_sync_events_updated_at
  BEFORE UPDATE ON square_sync_events
  FOR EACH ROW EXECUTE FUNCTION set_square_sync_events_updated_at();
