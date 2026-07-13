-- =============================================================================
-- supabase/seed.sql
-- Convenience-store seed fixture for "Corner Stop Convenience"
-- All UUIDs are fixed so the seed is deterministic and repeatable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Placeholder user (workaround: insert into auth.users directly so FKs work)
--    This is only safe for local dev; never do this in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001') THEN
    INSERT INTO auth.users (
      id, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role
    ) VALUES (
      '00000000-0000-0000-0000-000000000001',
      'owner@cornerstop.dev',
      '$2a$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456', -- placeholder hash
      now(),
      now(),
      now(),
      '{"provider":"email","providers":["email"]}',
      '{}',
      'authenticated',
      'authenticated'
    );
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. Business
-- -----------------------------------------------------------------------------
INSERT INTO businesses (business_id, name, timezone, currency, created_at, updated_at)
VALUES (
  'b1000000-0000-0000-0000-000000000001',
  'Corner Stop Convenience',
  'America/New_York',
  'USD',
  now() - INTERVAL '90 days',
  now() - INTERVAL '90 days'
)
ON CONFLICT (business_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Location
-- -----------------------------------------------------------------------------
INSERT INTO locations (location_id, business_id, name, address, is_active, created_at)
VALUES (
  'c2000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'Main Street Store',
  '123 Main Street, Springfield, IL 62701',
  true,
  now() - INTERVAL '90 days'
)
ON CONFLICT (location_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. User profile and role
-- -----------------------------------------------------------------------------
INSERT INTO user_profiles (user_id, business_id, display_name, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'Alex Owner',
  now() - INTERVAL '90 days'
)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO user_roles (user_role_id, user_id, business_id, role, created_at)
VALUES (
  'd3000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'owner',
  now() - INTERVAL '90 days'
)
ON CONFLICT (user_role_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. Suppliers
-- -----------------------------------------------------------------------------
INSERT INTO suppliers (
  supplier_id, business_id, name, contact_name, contact_email, contact_phone,
  lead_time_days, minimum_order_qty, notes, is_active, created_at
)
VALUES
(
  'e4000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'Metro Wholesale',
  'Janet Kim',
  'jkim@metrowholesale.com',
  '555-800-1234',
  3,
  24,
  'Primary beverage and snack distributor. Delivers Mon/Wed/Fri.',
  true,
  now() - INTERVAL '80 days'
),
(
  'e4000000-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000001',
  'Snack Distributors',
  'Marcus Webb',
  'mwebb@snackdist.com',
  '555-900-5678',
  5,
  12,
  'Tobacco, candy, and household goods. Delivers Tue/Thu.',
  true,
  now() - INTERVAL '80 days'
)
ON CONFLICT (supplier_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 5. Products (20 SKUs across 4 categories)
--    Fixed UUIDs: f5000000-0000-0000-0000-0000000000XX
--    Supplier mapping:
--      Metro Wholesale    (e4...001) → beverages, some snacks
--      Snack Distributors (e4...002) → tobacco, household, candy
-- -----------------------------------------------------------------------------
INSERT INTO products (
  product_id, business_id, sku, name, description, category,
  unit_of_measure, default_supplier_id,
  reorder_point, reorder_quantity, safety_stock, lead_time_days,
  cost_price, selling_price, is_active, created_at, updated_at
)
VALUES
-- Beverages (8 SKUs)
(
  'f5000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'BEV-COLA-20OZ', 'Coca-Cola 20oz', '20oz PET bottle', 'beverages',
  'each', 'e4000000-0000-0000-0000-000000000001',
  24, 144, 12, 3, 0.85, 2.19, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000001',
  'BEV-PEPSI-20OZ', 'Pepsi 20oz', '20oz PET bottle', 'beverages',
  'each', 'e4000000-0000-0000-0000-000000000001',
  24, 144, 12, 3, 0.82, 2.19, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000003',
  'b1000000-0000-0000-0000-000000000001',
  'BEV-WATER-16OZ', 'Dasani Water 16.9oz', '16.9oz still water', 'beverages',
  'each', 'e4000000-0000-0000-0000-000000000001',
  36, 288, 24, 3, 0.30, 1.49, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000004',
  'b1000000-0000-0000-0000-000000000001',
  'BEV-REDBULL-8OZ', 'Red Bull 8.4oz', '8.4oz energy drink', 'beverages',
  'each', 'e4000000-0000-0000-0000-000000000001',
  18, 96, 12, 3, 1.20, 3.29, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000005',
  'b1000000-0000-0000-0000-000000000001',
  'BEV-MONSTER-16OZ', 'Monster Energy 16oz', '16oz energy drink', 'beverages',
  'each', 'e4000000-0000-0000-0000-000000000001',
  18, 96, 12, 3, 1.10, 3.29, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000006',
  'b1000000-0000-0000-0000-000000000001',
  'BEV-GATORADE-32OZ', 'Gatorade Fruit Punch 32oz', '32oz sports drink', 'beverages',
  'each', 'e4000000-0000-0000-0000-000000000001',
  24, 120, 12, 3, 0.90, 2.49, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000007',
  'b1000000-0000-0000-0000-000000000001',
  'BEV-OJ-15OZ', 'Tropicana OJ 15oz', '15oz orange juice', 'beverages',
  'each', 'e4000000-0000-0000-0000-000000000001',
  12, 72, 6, 3, 1.05, 2.79, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000008',
  'b1000000-0000-0000-0000-000000000001',
  'BEV-COFFEECUP-12OZ', 'Stok Cold Brew 12oz', '12oz ready-to-drink cold brew', 'beverages',
  'each', 'e4000000-0000-0000-0000-000000000001',
  12, 72, 6, 3, 1.40, 3.49, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
)
ON CONFLICT (product_id) DO NOTHING;

-- Snacks (6 SKUs)
INSERT INTO products (
  product_id, business_id, sku, name, description, category,
  unit_of_measure, default_supplier_id,
  reorder_point, reorder_quantity, safety_stock, lead_time_days,
  cost_price, selling_price, is_active, created_at, updated_at
)
VALUES
(
  'f5000000-0000-0000-0000-000000000009',
  'b1000000-0000-0000-0000-000000000001',
  'SNK-LAYS-1OZ', 'Lay''s Classic Chips 1oz', '1oz single-serve chips', 'snacks',
  'each', 'e4000000-0000-0000-0000-000000000001',
  24, 144, 12, 3, 0.40, 1.49, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000010',
  'b1000000-0000-0000-0000-000000000001',
  'SNK-DORITOS-2OZ', 'Doritos Nacho Cheese 2oz', '2oz single-serve chips', 'snacks',
  'each', 'e4000000-0000-0000-0000-000000000001',
  24, 144, 12, 3, 0.55, 1.79, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000011',
  'b1000000-0000-0000-0000-000000000001',
  'SNK-SNICKERS-2OZ', 'Snickers Bar 1.86oz', 'Chocolate-caramel candy bar', 'snacks',
  'each', 'e4000000-0000-0000-0000-000000000002',
  30, 180, 15, 5, 0.65, 1.89, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000012',
  'b1000000-0000-0000-0000-000000000001',
  'SNK-ORBIT-GUM', 'Orbit Spearmint Gum 14ct', '14-stick peg gum', 'snacks',
  'each', 'e4000000-0000-0000-0000-000000000002',
  20, 120, 10, 5, 0.70, 1.99, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000013',
  'b1000000-0000-0000-0000-000000000001',
  'SNK-GRANOLA-BAR', 'Nature Valley Oats & Honey Bar', '2-pack granola bar', 'snacks',
  'each', 'e4000000-0000-0000-0000-000000000001',
  18, 108, 9, 3, 0.55, 1.69, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000014',
  'b1000000-0000-0000-0000-000000000001',
  'SNK-PEANUTS-175OZ', 'Planters Salted Peanuts 1.75oz', '1.75oz peanut snack pack', 'snacks',
  'each', 'e4000000-0000-0000-0000-000000000001',
  24, 144, 12, 3, 0.45, 1.49, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
)
ON CONFLICT (product_id) DO NOTHING;

-- Tobacco (3 SKUs - generic names only)
INSERT INTO products (
  product_id, business_id, sku, name, description, category,
  unit_of_measure, default_supplier_id,
  reorder_point, reorder_quantity, safety_stock, lead_time_days,
  cost_price, selling_price, is_active, created_at, updated_at
)
VALUES
(
  'f5000000-0000-0000-0000-000000000015',
  'b1000000-0000-0000-0000-000000000001',
  'TOB-CIG-A-20PK', 'Brand A Cigarettes 20pk', 'King size 20-cigarette pack', 'tobacco',
  'each', 'e4000000-0000-0000-0000-000000000002',
  40, 200, 20, 5, 7.50, 12.99, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000016',
  'b1000000-0000-0000-0000-000000000001',
  'TOB-CIG-B-20PK', 'Brand B Cigarettes 20pk', 'Menthol king size 20-cigarette pack', 'tobacco',
  'each', 'e4000000-0000-0000-0000-000000000002',
  30, 150, 15, 5, 7.25, 12.99, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000017',
  'b1000000-0000-0000-0000-000000000001',
  'TOB-CHEW-A-3OZ', 'Brand A Chewing Tobacco 3oz', '3oz can long-cut tobacco', 'tobacco',
  'each', 'e4000000-0000-0000-0000-000000000002',
  20, 100, 10, 5, 4.50, 8.49, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
)
ON CONFLICT (product_id) DO NOTHING;

-- Household (3 SKUs)
INSERT INTO products (
  product_id, business_id, sku, name, description, category,
  unit_of_measure, default_supplier_id,
  reorder_point, reorder_quantity, safety_stock, lead_time_days,
  cost_price, selling_price, is_active, created_at, updated_at
)
VALUES
(
  'f5000000-0000-0000-0000-000000000018',
  'b1000000-0000-0000-0000-000000000001',
  'HH-BATT-AA4PK', 'Duracell AA Batteries 4pk', '4-pack AA alkaline batteries', 'household',
  'each', 'e4000000-0000-0000-0000-000000000002',
  12, 72, 6, 5, 2.50, 5.99, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000019',
  'b1000000-0000-0000-0000-000000000001',
  'HH-SOAP-BAR', 'Dial Bar Soap 4oz', '4oz antibacterial bar soap', 'household',
  'each', 'e4000000-0000-0000-0000-000000000002',
  12, 72, 6, 5, 0.80, 2.29, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
),
(
  'f5000000-0000-0000-0000-000000000020',
  'b1000000-0000-0000-0000-000000000001',
  'HH-PAPERTOWEL-1', 'Bounty Select-A-Size 1 Roll', 'Single paper towel roll', 'household',
  'each', 'e4000000-0000-0000-0000-000000000002',
  12, 60, 6, 5, 1.20, 2.99, true,
  now() - INTERVAL '80 days', now() - INTERVAL '80 days'
)
ON CONFLICT (product_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 6. Product barcodes (UPC-A format)
-- -----------------------------------------------------------------------------
INSERT INTO product_barcodes (barcode_id, business_id, product_id, barcode_value, barcode_type, is_primary, created_at)
VALUES
('ab000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000001','049000028911','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000002','012000001765','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000003','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000003','049000028928','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000004','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000004','611269993001','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000005','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000005','070847811169','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000006','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000006','052000113829','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000007','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000007','048500203224','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000008','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000008','078742031194','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000009','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000009','028400090360','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000010','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000010','028400090087','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000011','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000011','040000481461','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000012','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000012','040000482000','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000013','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000013','016000124790','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000014','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000014','029000016095','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000015','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000015','071610000015','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000016','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000016','071610000016','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000017','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000017','071610000017','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000018','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000018','041333025193','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000019','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000019','017000023022','UPC-A',true,now() - INTERVAL '80 days'),
('ab000000-0000-0000-0000-000000000020','b1000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000020','037000768241','UPC-A',true,now() - INTERVAL '80 days')
ON CONFLICT (barcode_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 7. Inventory movements: 30 days of history
--    Strategy per product:
--      Day -30: large receive (opening stock)
--      Days -29 to -1: daily sale movements (quantity varies by product velocity)
--      Day -15: one mid-period receive to restock fast movers
--      Day -10: one adjustment (damage/spoilage) for a few products
--    user_id = NULL for system/POS sales; owner UUID for manual receives
-- -----------------------------------------------------------------------------

-- Helper: we'll build movements using generate_series for sales
-- First insert the opening receive for all 20 products (day -30)

INSERT INTO inventory_movements (
  movement_id, business_id, location_id, sku_id,
  quantity_delta, movement_type, source,
  user_id, notes, unit_cost, created_at
)
VALUES
-- Beverages opening stock
('mv000001-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000001', 144,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.85,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000002', 144,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.82,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000003','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000003', 288,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.30,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000004','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000004',  96,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',1.20,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000005','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000005',  96,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',1.10,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000006','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000006', 120,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.90,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000007','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000007',  72,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',1.05,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000008','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000008',  72,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',1.40,now()-INTERVAL'30 days'),
-- Snacks opening stock
('mv000001-0000-0000-0000-000000000009','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000009', 144,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.40,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000010','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000010', 144,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.55,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000011','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000011', 180,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.65,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000012','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000012', 120,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.70,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000013','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000013', 108,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.55,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000014','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000014', 144,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.45,now()-INTERVAL'30 days'),
-- Tobacco opening stock
('mv000001-0000-0000-0000-000000000015','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000015', 200,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',7.50,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000016','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000016', 150,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',7.25,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000017','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000017', 100,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',4.50,now()-INTERVAL'30 days'),
-- Household opening stock
('mv000001-0000-0000-0000-000000000018','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000018',  72,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',2.50,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000019','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000019',  72,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',0.80,now()-INTERVAL'30 days'),
('mv000001-0000-0000-0000-000000000020','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000020',  60,'receive','manual','00000000-0000-0000-0000-000000000001','Opening stock receive',1.20,now()-INTERVAL'30 days')
ON CONFLICT (movement_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 7b. Daily sale movements: generate_series over 29 days (day -29 to day -1)
--     Each product sells a fixed number per day. We use a DO block with a loop
--     so each row gets a unique movement_id via gen_random_uuid().
--     Sales per day (approximate velocity):
--       Coca-Cola 20oz:     5/day
--       Pepsi 20oz:         4/day
--       Dasani Water:       8/day
--       Red Bull:           3/day
--       Monster Energy:     3/day
--       Gatorade:           4/day
--       Tropicana OJ:       2/day
--       Stok Cold Brew:     2/day
--       Lay's Chips:        5/day
--       Doritos:            4/day
--       Snickers:           6/day
--       Orbit Gum:          4/day
--       Nature Valley:      3/day
--       Planters Peanuts:   4/day
--       Brand A Cigs:       8/day
--       Brand B Cigs:       6/day
--       Brand A Chew:       3/day
--       Duracell Batteries: 2/day
--       Dial Soap:          2/day
--       Bounty Paper Towel: 2/day
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_day        INTEGER;
  v_day_ts     TIMESTAMPTZ;
  v_biz_id     UUID := 'b1000000-0000-0000-0000-000000000001';
  v_loc_id     UUID := 'c2000000-0000-0000-0000-000000000001';
  -- product ids and daily sale quantities
  v_products   UUID[]    := ARRAY[
    'f5000000-0000-0000-0000-000000000001',
    'f5000000-0000-0000-0000-000000000002',
    'f5000000-0000-0000-0000-000000000003',
    'f5000000-0000-0000-0000-000000000004',
    'f5000000-0000-0000-0000-000000000005',
    'f5000000-0000-0000-0000-000000000006',
    'f5000000-0000-0000-0000-000000000007',
    'f5000000-0000-0000-0000-000000000008',
    'f5000000-0000-0000-0000-000000000009',
    'f5000000-0000-0000-0000-000000000010',
    'f5000000-0000-0000-0000-000000000011',
    'f5000000-0000-0000-0000-000000000012',
    'f5000000-0000-0000-0000-000000000013',
    'f5000000-0000-0000-0000-000000000014',
    'f5000000-0000-0000-0000-000000000015',
    'f5000000-0000-0000-0000-000000000016',
    'f5000000-0000-0000-0000-000000000017',
    'f5000000-0000-0000-0000-000000000018',
    'f5000000-0000-0000-0000-000000000019',
    'f5000000-0000-0000-0000-000000000020'
  ]::UUID[];
  v_daily_qty  INTEGER[] := ARRAY[5,4,8,3,3,4,2,2,5,4,6,4,3,4,8,6,3,2,2,2];
  v_i          INTEGER;
BEGIN
  FOR v_day IN 1..29 LOOP
    v_day_ts := now() - (INTERVAL '1 day' * (30 - v_day));
    FOR v_i IN 1..array_length(v_products, 1) LOOP
      INSERT INTO inventory_movements (
        movement_id, business_id, location_id, sku_id,
        quantity_delta, movement_type, source,
        user_id, notes, created_at
      )
      VALUES (
        gen_random_uuid(),
        v_biz_id,
        v_loc_id,
        v_products[v_i],
        -v_daily_qty[v_i],
        'sale',
        'pos_square',
        NULL,
        'POS sale',
        v_day_ts + (v_i * INTERVAL '1 minute')  -- stagger within the day
      );
    END LOOP;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 7c. Mid-period restock receive (day -15) for fast-moving beverages & tobacco
-- -----------------------------------------------------------------------------
INSERT INTO inventory_movements (
  movement_id, business_id, location_id, sku_id,
  quantity_delta, movement_type, source,
  user_id, notes, unit_cost, created_at
)
VALUES
('mv000002-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000001', 144,'receive','manual','00000000-0000-0000-0000-000000000001','Mid-period restock',0.85,now()-INTERVAL'15 days'),
('mv000002-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000002', 144,'receive','manual','00000000-0000-0000-0000-000000000001','Mid-period restock',0.82,now()-INTERVAL'15 days'),
('mv000002-0000-0000-0000-000000000003','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000003', 288,'receive','manual','00000000-0000-0000-0000-000000000001','Mid-period restock',0.30,now()-INTERVAL'15 days'),
('mv000002-0000-0000-0000-000000000004','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000015', 200,'receive','manual','00000000-0000-0000-0000-000000000001','Mid-period restock',7.50,now()-INTERVAL'15 days'),
('mv000002-0000-0000-0000-000000000005','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000016', 150,'receive','manual','00000000-0000-0000-0000-000000000001','Mid-period restock',7.25,now()-INTERVAL'15 days'),
('mv000002-0000-0000-0000-000000000006','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000011', 180,'receive','manual','00000000-0000-0000-0000-000000000001','Mid-period restock',0.65,now()-INTERVAL'15 days')
ON CONFLICT (movement_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 7d. Adjustment movements (day -10): damage/spoilage on a few products
-- -----------------------------------------------------------------------------
INSERT INTO inventory_movements (
  movement_id, business_id, location_id, sku_id,
  quantity_delta, movement_type, reason_code, source,
  user_id, notes, before_quantity, after_quantity, created_at
)
VALUES
-- 3 Dasani waters found damaged on shelf
('mv000003-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000003',-3,'adjustment','damage','manual','00000000-0000-0000-0000-000000000001','Damaged bottles found on shelf',NULL,NULL,now()-INTERVAL'10 days'),
-- 2 Gatorades expired
('mv000003-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000006',-2,'adjustment','spoilage','manual','00000000-0000-0000-0000-000000000001','Past best-by date — removed from floor',NULL,NULL,now()-INTERVAL'10 days'),
-- 1 Snickers bar missing (theft/shrinkage)
('mv000003-0000-0000-0000-000000000003','b1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000011',-1,'adjustment','theft','manual','00000000-0000-0000-0000-000000000001','Missing during cycle count',NULL,NULL,now()-INTERVAL'10 days')
ON CONFLICT (movement_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 8. Purchase Order: 1 submitted PO with 3 lines (Metro Wholesale)
-- -----------------------------------------------------------------------------
INSERT INTO purchase_orders (
  po_id, business_id, location_id, supplier_id,
  status, source, submitted_at, submitted_by,
  expected_delivery, notes, created_at, updated_at
)
VALUES (
  'po000001-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'c2000000-0000-0000-0000-000000000001',
  'e4000000-0000-0000-0000-000000000001',
  'submitted',
  'manual',
  now() - INTERVAL '2 days',
  '00000000-0000-0000-0000-000000000001',
  (now() + INTERVAL '1 day')::DATE,
  'Weekly beverage restock order.',
  now() - INTERVAL '3 days',
  now() - INTERVAL '2 days'
)
ON CONFLICT (po_id) DO NOTHING;

INSERT INTO purchase_order_lines (
  po_line_id, po_id, business_id, sku_id,
  ordered_quantity, received_quantity, unit_cost, status, created_at
)
VALUES
(
  'pl000001-0000-0000-0000-000000000001',
  'po000001-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'f5000000-0000-0000-0000-000000000001',
  144, 0, 0.85, 'pending',
  now() - INTERVAL '3 days'
),
(
  'pl000001-0000-0000-0000-000000000002',
  'po000001-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'f5000000-0000-0000-0000-000000000003',
  288, 0, 0.30, 'pending',
  now() - INTERVAL '3 days'
),
(
  'pl000001-0000-0000-0000-000000000003',
  'po000001-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'f5000000-0000-0000-0000-000000000004',
  96, 0, 1.20, 'pending',
  now() - INTERVAL '3 days'
)
ON CONFLICT (po_line_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 9. Alerts: 2 resolved, 1 active
-- -----------------------------------------------------------------------------
INSERT INTO alerts (
  alert_id, business_id, location_id, sku_id,
  alert_type, status,
  acknowledged_by, acknowledged_at, resolved_at,
  message, created_at
)
VALUES
-- Alert 1: resolved low_stock for Gatorade (was triggered ~20 days ago, restocked ~15 days ago)
(
  'al000001-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'c2000000-0000-0000-0000-000000000001',
  'f5000000-0000-0000-0000-000000000006',
  'low_stock',
  'resolved',
  '00000000-0000-0000-0000-000000000001',
  now() - INTERVAL '20 days',
  now() - INTERVAL '15 days',
  'Gatorade Fruit Punch 32oz stock fell to or below reorder point (24 units).',
  now() - INTERVAL '22 days'
),
-- Alert 2: resolved stockout for Red Bull (brief stockout ~18 days ago, restocked same day)
(
  'al000001-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000001',
  'c2000000-0000-0000-0000-000000000001',
  'f5000000-0000-0000-0000-000000000004',
  'stockout',
  'resolved',
  '00000000-0000-0000-0000-000000000001',
  now() - INTERVAL '18 days',
  now() - INTERVAL '18 days',
  'Red Bull 8.4oz is out of stock.',
  now() - INTERVAL '18 days'
),
-- Alert 3: active low_stock for Dasani Water (current sales velocity has depleted stock)
(
  'al000001-0000-0000-0000-000000000003',
  'b1000000-0000-0000-0000-000000000001',
  'c2000000-0000-0000-0000-000000000001',
  'f5000000-0000-0000-0000-000000000003',
  'low_stock',
  'active',
  NULL,
  NULL,
  NULL,
  'Dasani Water 16.9oz stock is at or below the reorder point (36 units). Consider reordering.',
  now() - INTERVAL '1 day'
)
ON CONFLICT (alert_id) DO NOTHING;

-- =============================================================================
-- End of seed.sql
-- =============================================================================
