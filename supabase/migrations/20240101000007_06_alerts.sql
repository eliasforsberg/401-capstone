-- Migration: 06_alerts
-- Creates the alerts table for low-stock, stockout, anomaly, and Square unmatched alerts

CREATE TABLE alerts (
  alert_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(business_id),
  location_id     UUID NOT NULL REFERENCES locations(location_id),
  sku_id          UUID REFERENCES products(product_id),
  alert_type      TEXT NOT NULL CHECK (alert_type IN ('low_stock','stockout','anomaly','square_unmatched')),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','acknowledged','resolved')),
  acknowledged_by UUID REFERENCES auth.users(id),
  acknowledged_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  message         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for querying active alerts by business and SKU
CREATE INDEX idx_alerts_active
  ON alerts (business_id, status, sku_id);
