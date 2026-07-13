-- Migration: 10_adjustment_approval_threshold
-- Adds an optional approval threshold to the businesses table.
-- When set, staff adjustments with ABS(quantity_delta) > threshold will be
-- held as pending_approval rather than applied immediately.
-- Requirements: 5.5, 5.6

ALTER TABLE businesses
  ADD COLUMN adjustment_approval_threshold NUMERIC(12,4) DEFAULT NULL;

COMMENT ON COLUMN businesses.adjustment_approval_threshold IS
  'When non-NULL, staff adjustments whose ABS(quantity_delta) exceeds this value '
  'require owner approval before the movement is recorded in the ledger.';
