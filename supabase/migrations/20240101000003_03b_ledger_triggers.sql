-- Migration: 03_ledger_triggers
-- Adds append-only enforcement trigger, balance update trigger with WAC recalculation,
-- and the get_inventory_balance() consistency function.
-- Requirements: 1.2, 1.3, 1.5, 10.7
--
-- NOTE: Alert condition evaluation is intentionally omitted here to avoid a
-- circular dependency on the `alerts` table (created in migration 06_alerts).
-- Alert evaluation will be added in task 21.1, which extends this trigger after
-- migration 06 has run.

-- ============================================================
-- 1. Append-only enforcement
-- Blocks any UPDATE or DELETE on inventory_movements.
-- This is the DB-layer guarantee of the ledger-first design principle.
-- ============================================================
CREATE OR REPLACE FUNCTION prevent_movement_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements is append-only; mutations are not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_movement_update
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION prevent_movement_mutation();

-- ============================================================
-- 2. Balance materialization trigger
-- Fires AFTER INSERT on inventory_movements and:
--   a) UPSERTs inventory_balances (adds quantity_delta to cached quantity)
--   b) When movement_type = 'receive', recalculates weighted average cost
--      on products.cost_price using the formula:
--        new_wac = (current_balance * current_cost + received_qty * unit_cost)
--                  / (current_balance + received_qty)
--
-- All operations run in the same transaction as the originating INSERT,
-- preserving the core invariant:
--   SUM(quantity_delta) WHERE sku_id=X AND location_id=Y
--     = inventory_balances.quantity WHERE sku_id=X AND location_id=Y
-- ============================================================
CREATE OR REPLACE FUNCTION update_inventory_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_new_quantity  NUMERIC(12,4);
  v_current_cost  NUMERIC(12,4);
  v_current_bal   NUMERIC(12,4);
BEGIN
  -- a) UPSERT the materialized balance
  INSERT INTO inventory_balances (business_id, location_id, sku_id, quantity, updated_at)
  VALUES (NEW.business_id, NEW.location_id, NEW.sku_id, NEW.quantity_delta, now())
  ON CONFLICT (business_id, location_id, sku_id)
  DO UPDATE SET
    quantity   = inventory_balances.quantity + NEW.quantity_delta,
    updated_at = now()
  RETURNING quantity INTO v_new_quantity;

  -- b) Weighted average cost recalculation on receive movements
  --    WAC = (current_balance * current_cost + received_qty * unit_cost)
  --          / (current_balance + received_qty)
  --    Only runs when unit_cost is provided; skips if denominator would be zero.
  IF NEW.movement_type = 'receive' AND NEW.unit_cost IS NOT NULL THEN
    -- The balance BEFORE this movement = new balance minus the delta just added
    v_current_bal := v_new_quantity - NEW.quantity_delta;

    SELECT cost_price INTO v_current_cost
    FROM products
    WHERE product_id = NEW.sku_id;

    -- Guard: only update if the post-receive balance is positive (avoid div-by-zero)
    IF v_new_quantity > 0 THEN
      IF v_current_cost IS NULL OR v_current_bal <= 0 THEN
        -- No prior stock or no prior cost — new cost becomes the unit cost of this receipt
        UPDATE products
        SET cost_price = NEW.unit_cost,
            updated_at = now()
        WHERE product_id = NEW.sku_id;
      ELSE
        -- Standard weighted average cost formula
        UPDATE products
        SET cost_price = (v_current_bal * v_current_cost + NEW.quantity_delta * NEW.unit_cost)
                         / v_new_quantity,
            updated_at = now()
        WHERE product_id = NEW.sku_id;
      END IF;
    END IF;
  END IF;

  -- TODO (task 21.1): After migration 06_alerts runs, extend this trigger to
  -- evaluate alert conditions:
  --   - IF new_balance <= product.reorder_point → INSERT low_stock alert (if none active)
  --   - IF new_balance <= 0                     → INSERT stockout alert
  --   - IF new_balance > reorder_point AND active low_stock alert → resolve it

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_balance
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION update_inventory_balance();

-- ============================================================
-- 3. Consistency verification function
-- Computes balance directly from the ledger.
-- Must always equal inventory_balances.quantity for the same SKU/location pair.
-- Used in integration tests (task 12.3) and the seed validation test (task 7.2).
-- ============================================================
CREATE OR REPLACE FUNCTION get_inventory_balance(p_sku_id UUID, p_location_id UUID)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(quantity_delta), 0)
  FROM inventory_movements
  WHERE sku_id      = p_sku_id
    AND location_id = p_location_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
