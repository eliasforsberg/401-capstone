-- Migration: 04_purchase_orders
-- Creates purchase order management tables:
--   purchase_orders, purchase_order_lines
-- Requirements: 14.1, 14.7

-- ---------------------------------------------------------------------------
-- purchase_orders
-- Represents a single order placed with a supplier for a given location.
-- Status machine: draft → submitted → partially_received → received | cancelled
-- Source tracks whether the PO was created manually or by the AI engine.
-- ---------------------------------------------------------------------------
CREATE TABLE purchase_orders (
  po_id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID        NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  location_id         UUID        NOT NULL REFERENCES locations(location_id),
  supplier_id         UUID        NOT NULL REFERENCES suppliers(supplier_id),
  status              TEXT        NOT NULL DEFAULT 'draft'
                                    CHECK (status IN ('draft', 'submitted', 'partially_received', 'received', 'cancelled')),
  source              TEXT        NOT NULL DEFAULT 'manual'
                                    CHECK (source IN ('manual', 'ai_suggested')),
  submitted_at        TIMESTAMPTZ,
  submitted_by        UUID        REFERENCES auth.users(id),
  expected_delivery   DATE,
  notes               TEXT,
  attachment_paths    TEXT[],       -- Supabase Storage paths for receipt documents
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_purchase_orders_updated_at
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Composite index for status-filtered PO lookups (e.g. open POs per business)
CREATE INDEX idx_po_status ON purchase_orders (business_id, status);

-- ---------------------------------------------------------------------------
-- purchase_order_lines
-- Individual line items within a purchase order — one row per SKU ordered.
-- ordered_quantity is immutable after submission; received_quantity increments
-- on each partial receive call from the receive-stock Edge Function.
-- rationale_text is populated by the AI engine for ai_suggested POs.
-- ---------------------------------------------------------------------------
CREATE TABLE purchase_order_lines (
  po_line_id          UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id               UUID           NOT NULL REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
  business_id         UUID           NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  sku_id              UUID           NOT NULL REFERENCES products(product_id),
  ordered_quantity    NUMERIC(12,4)  NOT NULL,
  received_quantity   NUMERIC(12,4)  NOT NULL DEFAULT 0,
  unit_cost           NUMERIC(12,4),
  status              TEXT           NOT NULL DEFAULT 'pending'
                                       CHECK (status IN ('pending', 'partially_received', 'received')),
  rationale_text      TEXT,           -- AI-generated explanation for ai_suggested POs
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX idx_po_lines_po_id      ON purchase_order_lines (po_id);
CREATE INDEX idx_po_lines_sku_id     ON purchase_order_lines (business_id, sku_id);
