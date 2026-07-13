-- Migration: 03_inventory_ledger
-- Creates the append-only inventory movement ledger and materialized balance table.
-- Requirements: 1.1, 14.1, 14.7
--
-- NOTE: Triggers and RLS policies are added in subsequent migrations (4.2, 4.3).

-- ============================================================
-- Append-only movement ledger
-- NEVER UPDATE OR DELETE ROWS in this table.
-- ============================================================
CREATE TABLE inventory_movements (
  movement_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(business_id),
  location_id     UUID NOT NULL REFERENCES locations(location_id),
  sku_id          UUID NOT NULL REFERENCES products(product_id),
  quantity_delta  NUMERIC(12,4) NOT NULL,  -- positive = inbound, negative = outbound
  movement_type   TEXT NOT NULL CHECK (movement_type IN (
                    'receive',
                    'sale',
                    'return',
                    'adjustment',
                    'count_correction',
                    'transfer'
                  )),
  reason_code     TEXT,             -- for adjustment / count_correction movements
  source          TEXT NOT NULL CHECK (source IN (
                    'pos_square',
                    'manual',
                    'system'
                  )),
  reference_id    UUID,             -- square event id, PO id, count session id, etc.
  user_id         UUID REFERENCES auth.users(id),
  edge_fn_id      TEXT,             -- populated when source = 'system'
  notes           TEXT,
  before_quantity NUMERIC(12,4),   -- snapshot captured before this movement (adjustments)
  after_quantity  NUMERIC(12,4),   -- snapshot captured after  this movement (adjustments)
  unit_cost       NUMERIC(12,4),   -- for receive movements (used in WAC calculation)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Materialized balance cache
-- Must always equal SUM(quantity_delta) for the SKU/location pair.
-- Updated atomically by the trg_update_balance trigger (added in 4.2).
-- ============================================================
CREATE TABLE inventory_balances (
  balance_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(business_id),
  location_id     UUID NOT NULL REFERENCES locations(location_id),
  sku_id          UUID NOT NULL REFERENCES products(product_id),
  quantity        NUMERIC(12,4) NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, location_id, sku_id)
);

-- ============================================================
-- Indexes (Requirements 14.7)
-- ============================================================

-- Balance computation, movement history, and time-range reports
CREATE INDEX idx_movements_sku_location
  ON inventory_movements (business_id, sku_id, location_id, created_at DESC);

-- Square / PO / count-session reference lookups
CREATE INDEX idx_movements_reference
  ON inventory_movements (reference_id);

-- Movement type + source filtering for reports and reconciliation
CREATE INDEX idx_movements_type_source
  ON inventory_movements (business_id, movement_type, source, created_at DESC);
