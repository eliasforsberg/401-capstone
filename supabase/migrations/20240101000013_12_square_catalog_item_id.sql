-- Migration: 12_square_catalog_item_id
-- Adds square_catalog_item_id to products so the square-webhook Edge Function
-- can look up a product by its Square catalog item ID without relying on the
-- sku column (which is the business's internal identifier).
--
-- The column is nullable because existing products may not yet have a Square
-- catalog item linked (they are linked via the square-catalog-sync function).
--
-- Requirements: 3.1 (SKU matching by Square catalog item ID)

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS square_catalog_item_id TEXT;

-- Index for fast lookup by Square catalog item ID within a business
CREATE INDEX IF NOT EXISTS idx_products_square_catalog_item_id
  ON products (business_id, square_catalog_item_id)
  WHERE square_catalog_item_id IS NOT NULL;
