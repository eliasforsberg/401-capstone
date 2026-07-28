-- Migration: 15_alert_trigger_extension
-- Extends the update_inventory_balance() trigger function to evaluate alert conditions
-- after every balance update.  This migration runs AFTER 06_alerts.sql has created
-- the `alerts` table so there is no circular dependency.
--
-- Alert rules implemented:
--   1. IF new_balance <= product.reorder_point
--        AND no active low_stock alert exists for (business_id, location_id, sku_id)
--      THEN INSERT low_stock alert
--
--   2. IF new_balance <= 0
--      THEN INSERT stockout alert (deduplication check applies here too)
--
--   3. IF new_balance > product.reorder_point
--        AND an active low_stock alert exists for (business_id, location_id, sku_id)
--      THEN UPDATE alert status to 'resolved', set resolved_at = now()
--
-- Requirements: 4.1, 4.2, 4.3, 4.5, 4.7
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_inventory_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_new_quantity    NUMERIC(12,4);
  v_current_cost    NUMERIC(12,4);
  v_current_bal     NUMERIC(12,4);
  v_reorder_point   NUMERIC(12,4);
  v_active_low      UUID;    -- alert_id of an existing active low_stock alert
  v_active_stockout UUID;    -- alert_id of an existing active stockout alert
BEGIN
  -- -----------------------------------------------------------------------
  -- 1. UPSERT the materialized balance
  -- -----------------------------------------------------------------------
  INSERT INTO inventory_balances (business_id, location_id, sku_id, quantity, updated_at)
  VALUES (NEW.business_id, NEW.location_id, NEW.sku_id, NEW.quantity_delta, now())
  ON CONFLICT (business_id, location_id, sku_id)
  DO UPDATE SET
    quantity   = inventory_balances.quantity + NEW.quantity_delta,
    updated_at = now()
  RETURNING quantity INTO v_new_quantity;

  -- -----------------------------------------------------------------------
  -- 2. Weighted average cost recalculation on receive movements
  -- -----------------------------------------------------------------------
  IF NEW.movement_type = 'receive' AND NEW.unit_cost IS NOT NULL THEN
    v_current_bal := v_new_quantity - NEW.quantity_delta;

    SELECT cost_price INTO v_current_cost
    FROM products
    WHERE product_id = NEW.sku_id;

    IF v_new_quantity > 0 THEN
      IF v_current_cost IS NULL OR v_current_bal <= 0 THEN
        UPDATE products
        SET cost_price = NEW.unit_cost,
            updated_at = now()
        WHERE product_id = NEW.sku_id;
      ELSE
        UPDATE products
        SET cost_price = (v_current_bal * v_current_cost + NEW.quantity_delta * NEW.unit_cost)
                         / v_new_quantity,
            updated_at = now()
        WHERE product_id = NEW.sku_id;
      END IF;
    END IF;
  END IF;

  -- -----------------------------------------------------------------------
  -- 3. Alert condition evaluation
  -- -----------------------------------------------------------------------

  -- Fetch the product's reorder_point (may be NULL for non-product movements)
  SELECT reorder_point INTO v_reorder_point
  FROM products
  WHERE product_id = NEW.sku_id;

  -- Only evaluate alert logic when a product record exists
  IF v_reorder_point IS NOT NULL THEN

    -- Look up any existing active low_stock alert for this SKU + location
    SELECT alert_id INTO v_active_low
    FROM alerts
    WHERE business_id = NEW.business_id
      AND location_id  = NEW.location_id
      AND sku_id       = NEW.sku_id
      AND alert_type   = 'low_stock'
      AND status       = 'active'
    LIMIT 1;

    -- Look up any existing active stockout alert
    SELECT alert_id INTO v_active_stockout
    FROM alerts
    WHERE business_id = NEW.business_id
      AND location_id  = NEW.location_id
      AND sku_id       = NEW.sku_id
      AND alert_type   = 'stockout'
      AND status       = 'active'
    LIMIT 1;

    -- --- Rule 3: balance rose above reorder_point — resolve active low_stock alert ---
    IF v_new_quantity > v_reorder_point THEN
      IF v_active_low IS NOT NULL THEN
        UPDATE alerts
        SET status      = 'resolved',
            resolved_at = now()
        WHERE alert_id = v_active_low;
      END IF;

      -- Also resolve any lingering stockout alert
      IF v_active_stockout IS NOT NULL THEN
        UPDATE alerts
        SET status      = 'resolved',
            resolved_at = now()
        WHERE alert_id = v_active_stockout;
      END IF;

    ELSE
      -- --- Rule 1: low_stock ---
      IF v_new_quantity <= v_reorder_point AND v_active_low IS NULL THEN
        INSERT INTO alerts (
          business_id, location_id, sku_id,
          alert_type, status, message, created_at
        ) VALUES (
          NEW.business_id, NEW.location_id, NEW.sku_id,
          'low_stock', 'active',
          'Stock quantity (' || v_new_quantity::TEXT || ') has reached or fallen below the reorder point (' || v_reorder_point::TEXT || ').',
          now()
        );
      END IF;

      -- --- Rule 2: stockout (quantity <= 0) ---
      IF v_new_quantity <= 0 AND v_active_stockout IS NULL THEN
        INSERT INTO alerts (
          business_id, location_id, sku_id,
          alert_type, status, message, created_at
        ) VALUES (
          NEW.business_id, NEW.location_id, NEW.sku_id,
          'stockout', 'active',
          'Stock quantity has reached zero — this item is out of stock.',
          now()
        );
      END IF;
    END IF;

  END IF; -- end v_reorder_point IS NOT NULL

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The trigger binding (trg_update_balance) was created in migration 03b and still
-- points to update_inventory_balance(); replacing the function is sufficient.
-- No DROP/CREATE TRIGGER needed.
