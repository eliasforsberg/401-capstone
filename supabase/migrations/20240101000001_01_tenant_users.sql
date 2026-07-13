-- Migration: 01_tenant_users
-- Creates core tenant and user management tables:
--   businesses, locations, user_profiles, user_roles
-- Requirements: 14.1, 14.6

-- ---------------------------------------------------------------------------
-- updated_at trigger function (reusable across tables)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- businesses
-- Tenant root. One row per registered business.
-- ---------------------------------------------------------------------------
CREATE TABLE businesses (
  business_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  timezone     TEXT        NOT NULL DEFAULT 'UTC',
  currency     TEXT        NOT NULL DEFAULT 'USD',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_businesses_updated_at
  BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- locations
-- Physical store locations belonging to a business.
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
  location_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID        NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  address      TEXT,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_locations_business_id ON locations (business_id);

-- ---------------------------------------------------------------------------
-- user_profiles
-- Extends Supabase auth.users with business membership and display info.
-- Cascades on auth user deletion so orphaned profiles are removed automatically.
-- ---------------------------------------------------------------------------
CREATE TABLE user_profiles (
  user_id      UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id  UUID        NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_profiles_business_id ON user_profiles (business_id);

-- ---------------------------------------------------------------------------
-- user_roles
-- Role assignment: one role per user per business.
-- Allowed roles: owner | staff | purchasing | accountant
-- The UNIQUE constraint on (user_id, business_id) enforces one role per user
-- per tenant, keeping role logic simple for the JWT claim injection hook.
-- ---------------------------------------------------------------------------
CREATE TABLE user_roles (
  user_role_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id   UUID        NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  role          TEXT        NOT NULL CHECK (role IN ('owner', 'staff', 'purchasing', 'accountant')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, business_id)
);

CREATE INDEX idx_user_roles_business_id ON user_roles (business_id);
CREATE INDEX idx_user_roles_user_id     ON user_roles (user_id);
