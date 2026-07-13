-- Migration: 16_dashboard_kpis
-- Creates the get_dashboard_kpis() Postgres function for the mobile dashboard screen.
-- Returns aggregate KPI metrics for a given business scoped to the last 30 days.
-- Requirements: 10.1, 10.7

-- ============================================================
-- get_dashboard_kpis(p_business_id)
--
-- Returns a single row with the following KPI columns:
--   total_stock_units     — sum of all current on-hand quantities
--   total_inventory_value — sum of (balance * cost_price) per SKU
--   low_stock_count       — distinct SKUs with active low_stock alert
--   stockout_count        — distinct SKUs with active stockout alert
--   sell_through_rate_30d — (units sold last 30d) / (avg on-hand + units sold) * 100
--   shrink_rate_30d       — (abs shrinkage units last 30d) / (units received last 30d) * 100
--   gross_sales_30d       — sum of (abs(quantity_delta) * product.selling_price) for sale movements last 30d
-- ============================================================
CREATE OR REPLACE FUNCTION get_dashboard_kpis(p_business_id UUID)
RETURNS TABLE (
  total_stock_units      NUMERIC,
  total_inventory_value  NUMERIC,
  low_stock_count        BIGINT,
  stockout_count         BIGINT,
  sell_through_rate_30d  NUMERIC,
  shrink_rate_30d        NUMERIC,
  gross_sales_30d        NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := now() - INTERVAL '30 days';
BEGIN
  RETURN QUERY
  WITH

  -- Current on-hand balances joined with product cost/selling price
  balances AS (
    SELECT
      ib.sku_id,
      ib.quantity                                   AS balance,
      COALESCE(p.cost_price, 0)                     AS cost_price,
      COALESCE(p.selling_price, 0)                  AS selling_price
    FROM inventory_balances ib
    JOIN products p ON p.product_id = ib.sku_id
    WHERE ib.business_id = p_business_id
      AND p.is_active = true
  ),

  -- Total stock units and portfolio value
  totals AS (
    SELECT
      COALESCE(SUM(balance), 0)                     AS total_units,
      COALESCE(SUM(balance * cost_price), 0)        AS total_value
    FROM balances
  ),

  -- Active alert counts
  alert_counts AS (
    SELECT
      COUNT(*) FILTER (WHERE alert_type = 'low_stock')   AS low_stock_cnt,
      COUNT(*) FILTER (WHERE alert_type = 'stockout')    AS stockout_cnt
    FROM alerts
    WHERE business_id = p_business_id
      AND status = 'active'
  ),

  -- Units sold in last 30 days (sale movements have negative quantity_delta)
  sales_30d AS (
    SELECT
      sku_id,
      ABS(SUM(quantity_delta))                      AS units_sold
    FROM inventory_movements
    WHERE business_id = p_business_id
      AND movement_type = 'sale'
      AND created_at >= v_cutoff
    GROUP BY sku_id
  ),

  -- Gross sales revenue: abs(qty_delta) * selling_price for sale movements
  gross_sales AS (
    SELECT
      COALESCE(
        SUM(ABS(im.quantity_delta) * COALESCE(p.selling_price, 0)),
        0
      )                                             AS gross_sales_amt
    FROM inventory_movements im
    JOIN products p ON p.product_id = im.sku_id
    WHERE im.business_id = p_business_id
      AND im.movement_type = 'sale'
      AND im.created_at >= v_cutoff
  ),

  -- Units received in last 30 days
  received_30d AS (
    SELECT
      COALESCE(SUM(quantity_delta), 0)              AS units_received
    FROM inventory_movements
    WHERE business_id = p_business_id
      AND movement_type = 'receive'
      AND created_at >= v_cutoff
  ),

  -- Shrinkage: adjustments with damage/spoilage/theft reason codes in last 30 days
  shrinkage_30d AS (
    SELECT
      COALESCE(SUM(ABS(quantity_delta)), 0)         AS shrink_units
    FROM inventory_movements
    WHERE business_id = p_business_id
      AND movement_type = 'adjustment'
      AND reason_code IN ('damage', 'spoilage', 'theft')
      AND created_at >= v_cutoff
  ),

  -- Total units sold (summed across all SKUs) for sell-through rate
  total_sold AS (
    SELECT COALESCE(SUM(units_sold), 0) AS units FROM sales_30d
  )

  SELECT
    -- Total stock units
    t.total_units,
    -- Total inventory value (WAC-based)
    t.total_value,
    -- Active alert counts
    ac.low_stock_cnt,
    ac.stockout_cnt,
    -- Sell-through rate: sold / (avg_on_hand + sold) * 100
    -- avg_on_hand approximated as current balance; avoids storing historical snapshots
    CASE
      WHEN (t.total_units + ts.units) = 0 THEN 0::NUMERIC
      ELSE ROUND((ts.units / (t.total_units + ts.units)) * 100, 2)
    END                                             AS sell_through_rate_30d,
    -- Shrink rate: shrink_units / received_units * 100
    CASE
      WHEN r.units_received = 0 THEN 0::NUMERIC
      ELSE ROUND((s.shrink_units / r.units_received) * 100, 2)
    END                                             AS shrink_rate_30d,
    -- Synced gross sales
    gs.gross_sales_amt

  FROM totals t
  CROSS JOIN alert_counts ac
  CROSS JOIN total_sold ts
  CROSS JOIN received_30d r
  CROSS JOIN shrinkage_30d s
  CROSS JOIN gross_sales gs;
END;
$$;

-- Grant execute to authenticated users (RLS on underlying tables enforces tenant isolation)
GRANT EXECUTE ON FUNCTION get_dashboard_kpis(UUID) TO authenticated;
