-- Migration: 08_ai_recommendations
-- Creates the recommendations and recommendation_feedback tables for the AI layer

CREATE TABLE recommendations (
  recommendation_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(business_id),
  recommendation_type TEXT NOT NULL CHECK (recommendation_type IN ('reorder','dead_stock','count_priority','anomaly')),
  sku_id              UUID REFERENCES products(product_id),
  rationale_text      TEXT NOT NULL,
  confidence_level    TEXT NOT NULL CHECK (confidence_level IN ('heuristic','forecast')),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','accepted','rejected','expired')),
  suggested_quantity  NUMERIC(12,4),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')
);

CREATE TABLE recommendation_feedback (
  feedback_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id   UUID NOT NULL REFERENCES recommendations(recommendation_id),
  business_id         UUID NOT NULL REFERENCES businesses(business_id),
  user_id             UUID NOT NULL REFERENCES auth.users(id),
  action              TEXT NOT NULL CHECK (action IN ('accepted','rejected','modified')),
  rejection_reason    TEXT CHECK (rejection_reason IN ('already_ordered','not_needed','wrong_quantity','other')),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fetching pending/active recommendations for a business feed
CREATE INDEX idx_recommendations_pending
  ON recommendations (business_id, status, created_at DESC);
