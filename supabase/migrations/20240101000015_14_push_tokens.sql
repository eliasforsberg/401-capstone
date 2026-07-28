-- Migration: 14_push_tokens
-- Creates push_tokens and notification_preferences tables.
--
-- ⚠️  MVP NOTE: Push notification DELIVERY is NOT activated in the MVP.
--     This schema is architected now so the infrastructure is ready for Phase 2
--     when Expo Notifications integration is enabled.  The Edge Functions that
--     read these tables and dispatch push notifications will be built in Phase 2.
--
-- Requirements: 4.9
-- ---------------------------------------------------------------------------

-- ============================================================
-- push_tokens
-- Stores an Expo push token per user/device/business combination.
-- A single user may have multiple tokens (multiple devices or re-installs).
-- ============================================================
CREATE TABLE push_tokens (
  token_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id       UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  expo_push_token   TEXT NOT NULL,
  platform          TEXT CHECK (platform IN ('ios', 'android')),
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for looking up all active tokens for a user/business (used when
-- dispatching a notification in Phase 2)
CREATE INDEX idx_push_tokens_user_business
  ON push_tokens (user_id, business_id)
  WHERE is_active = true;

-- ============================================================
-- notification_preferences
-- One row per user/business pair; controls which alert types trigger a push.
-- Defaults to enabled for the alert types that matter most in MVP.
-- ============================================================
CREATE TABLE notification_preferences (
  pref_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id         UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  low_stock_enabled   BOOLEAN NOT NULL DEFAULT true,
  stockout_enabled    BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Enforce exactly one preference row per user per business
  UNIQUE (user_id, business_id)
);
