-- Migration: 11_inventory_adjustments_pending
-- Stores stock adjustments that are awaiting owner approval.
-- Used when businesses.adjustment_approval_threshold is set and a staff user
-- submits an adjustment with ABS(quantity_delta) exceeding that threshold.
--
-- Approved rows are transferred to inventory_movements by the approve-adjustment
-- Edge Function (task 16.2). Rejected rows remain here with status = 'rejected'.
--
-- Requirements: 5.5, 5.6, 5.7, 5.8

CREATE TABLE inventory_adjustments_pending (
  adjustment_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID        NOT NULL REFERENCES businesses(business_id),
  location_id         UUID        NOT NULL REFERENCES locations(location_id),
  sku_id              UUID        NOT NULL REFERENCES products(product_id),
  quantity_delta      NUMERIC(12,4) NOT NULL,
  reason_code         TEXT        NOT NULL CHECK (reason_code IN (
                        'damage',
                        'spoilage',
                        'theft',
                        'counting_correction',
                        'supplier_shortage',
                        'internal_use',
                        'transfer_correction',
                        'other'
                      )),
  notes               TEXT,
  before_quantity     NUMERIC(12,4) NOT NULL,
  after_quantity      NUMERIC(12,4) NOT NULL,
  submitted_by        UUID        NOT NULL REFERENCES auth.users(id),
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  status              TEXT        NOT NULL DEFAULT 'pending_approval'
                        CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  reviewed_by         UUID        REFERENCES auth.users(id),
  reviewed_at         TIMESTAMPTZ,
  -- movement_id is populated by the approve-adjustment Edge Function after
  -- the corresponding inventory_movements row is created (task 16.2).
  movement_id         UUID        REFERENCES inventory_movements(movement_id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup of pending adjustments per business (used by approval UI)
CREATE INDEX idx_pending_adjustments_business
  ON inventory_adjustments_pending (business_id, status, submitted_at DESC);

-- Allow joining from inventory_movements back to the source pending record
CREATE INDEX idx_pending_adjustments_movement
  ON inventory_adjustments_pending (movement_id);
