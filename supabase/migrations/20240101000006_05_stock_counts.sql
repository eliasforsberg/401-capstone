-- Migration: 05_stock_counts
-- Creates stock count management tables:
--   stock_count_sessions, stock_count_lines
-- Requirements: 14.1, 14.7

-- ---------------------------------------------------------------------------
-- stock_count_sessions
-- Represents a single cycle count or full audit event at a location.
-- snapshot_quantity on each count_line is captured at session start so
-- the system can compute variance even if movements occur during counting.
-- ---------------------------------------------------------------------------
CREATE TABLE stock_count_sessions (
  session_id      UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID           NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  location_id     UUID           NOT NULL REFERENCES locations(location_id),
  count_type      TEXT           NOT NULL CHECK (count_type IN ('cycle_count', 'full_audit')),
  status          TEXT           NOT NULL DEFAULT 'in_progress'
                                   CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  started_by      UUID           NOT NULL REFERENCES auth.users(id),
  started_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  total_skus      INTEGER,
  total_variance  NUMERIC(12,4),  -- sum of ABS(variance) across all lines
  variance_value  NUMERIC(12,4),  -- monetary value of variance (total_variance * cost_price)
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX idx_count_sessions_business_id ON stock_count_sessions (business_id, status);

-- ---------------------------------------------------------------------------
-- stock_count_lines
-- One row per SKU in scope for the count session.
-- snapshot_quantity is the balance at session start (immutable).
-- counted_quantity and variance are populated when the operator scans/submits.
-- movement_id links to the count_correction movement created on submission
-- (NULL until the line is submitted and the correction movement is inserted).
-- ---------------------------------------------------------------------------
CREATE TABLE stock_count_lines (
  count_line_id       UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID           NOT NULL REFERENCES stock_count_sessions(session_id) ON DELETE CASCADE,
  business_id         UUID           NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  sku_id              UUID           NOT NULL REFERENCES products(product_id),
  snapshot_quantity   NUMERIC(12,4)  NOT NULL,   -- balance captured at session start
  counted_quantity    NUMERIC(12,4),              -- operator-entered count
  variance            NUMERIC(12,4),              -- counted_quantity - snapshot_quantity
  movement_id         UUID           REFERENCES inventory_movements(movement_id),  -- count_correction movement, nullable
  scanned_at          TIMESTAMPTZ,
  submitted_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX idx_count_lines_session_id ON stock_count_lines (session_id);
CREATE INDEX idx_count_lines_sku_id     ON stock_count_lines (business_id, sku_id);
