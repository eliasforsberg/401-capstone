-- Migration: 02_product_catalog
-- Tables: suppliers, products, product_barcodes, product_variants
-- Requirements: 7.5, 14.1, 14.7

-- Suppliers
CREATE TABLE suppliers (
  supplier_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(business_id),
  name                TEXT NOT NULL,
  contact_name        TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  lead_time_days      INTEGER NOT NULL DEFAULT 3,
  minimum_order_qty   NUMERIC(12,4) NOT NULL DEFAULT 1,
  notes               TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Products
CREATE TABLE products (
  product_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(business_id),
  sku                 TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  category            TEXT,
  unit_of_measure     TEXT NOT NULL DEFAULT 'each',
  default_supplier_id UUID REFERENCES suppliers(supplier_id),
  reorder_point       NUMERIC(12,4) NOT NULL DEFAULT 0,
  reorder_quantity    NUMERIC(12,4) NOT NULL DEFAULT 0,
  safety_stock        NUMERIC(12,4) NOT NULL DEFAULT 0,
  lead_time_days      INTEGER,
  cost_price          NUMERIC(12,4),
  selling_price       NUMERIC(12,4),
  image_storage_path  TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, sku)
);

-- Product Barcodes
CREATE TABLE product_barcodes (
  barcode_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(business_id),
  product_id      UUID NOT NULL REFERENCES products(product_id),
  barcode_value   TEXT NOT NULL,
  barcode_type    TEXT,
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, barcode_value)
);

-- Product Variants
CREATE TABLE product_variants (
  variant_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          UUID NOT NULL REFERENCES products(product_id),
  business_id         UUID NOT NULL REFERENCES businesses(business_id),
  sku                 TEXT NOT NULL,
  name                TEXT NOT NULL,
  unit_multiplier     NUMERIC(12,4) NOT NULL DEFAULT 1,
  cost_price          NUMERIC(12,4),
  selling_price       NUMERIC(12,4),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, sku)
);

-- Index for fast barcode resolution (critical path)
CREATE INDEX idx_barcodes_lookup ON product_barcodes (business_id, barcode_value);
