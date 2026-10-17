-- ============================================================================
-- SUPABASE MIGRATION: SpaceMatch Addis — Telegram Channel Matching System
-- Date: 2026-10-16
-- Description: Adds profiles, matches, payments tables for the new bot flow.
--              Coexists with existing users/roommate_profiles/orders schema.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. ENUM TYPES (with IF NOT EXISTS guards to avoid conflicts)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'profile_status') THEN
    CREATE TYPE public.profile_status AS ENUM (
      'onboarding',
      'active',
      'paused',
      'matched'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kyc_status') THEN
    CREATE TYPE public.kyc_status AS ENUM (
      'pending',
      'verified',
      'rejected'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'match_status') THEN
    CREATE TYPE public.match_status AS ENUM (
      'pending_acceptance',
      'declined',
      'pending_payment',
      'completed',
      'expired'
    );
  END IF;

  -- Named match_payment_status to avoid clashing with the existing payment_status enum
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'match_payment_status') THEN
    CREATE TYPE public.match_payment_status AS ENUM (
      'unpaid',
      'one_paid',
      'both_paid'
    );
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. PROFILES TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id        BIGINT      UNIQUE NOT NULL,
  display_code       TEXT        UNIQUE NOT NULL,
  onboarding_step    TEXT        NOT NULL DEFAULT 'gender',
  gender             TEXT,
  locations          TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
  budget_min         NUMERIC     NOT NULL DEFAULT 0,
  budget_max         NUMERIC     NOT NULL DEFAULT 0,
  move_in_date       TEXT,
  roommate_traits    TEXT,
  full_name          TEXT,
  phone_number       TEXT,
  telegram_username  TEXT,
  kyc_doc_path       TEXT,
  kyc_status         public.kyc_status     NOT NULL DEFAULT 'pending',
  status             public.profile_status NOT NULL DEFAULT 'onboarding',
  channel_message_id BIGINT,
  pending_req_code   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_telegram_id  ON public.profiles(telegram_id);
CREATE INDEX IF NOT EXISTS idx_profiles_display_code ON public.profiles(display_code);
CREATE INDEX IF NOT EXISTS idx_profiles_status       ON public.profiles(status);

-- ----------------------------------------------------------------------------
-- 3. MATCHES TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.matches (
  id               UUID                        PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id     UUID                        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_id        UUID                        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requester_paid   BOOLEAN                     NOT NULL DEFAULT false,
  target_paid      BOOLEAN                     NOT NULL DEFAULT false,
  payment_status   public.match_payment_status NOT NULL DEFAULT 'unpaid',
  status           public.match_status         NOT NULL DEFAULT 'pending_acceptance',
  created_at       TIMESTAMPTZ                 NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  CONSTRAINT uq_match_pair UNIQUE (requester_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_requester ON public.matches(requester_id);
CREATE INDEX IF NOT EXISTS idx_matches_target    ON public.matches(target_id);
CREATE INDEX IF NOT EXISTS idx_matches_status    ON public.matches(status);

-- ----------------------------------------------------------------------------
-- 4. PAYMENTS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id    UUID        NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bank        TEXT        NOT NULL CHECK (bank IN ('telebirr', 'cbe')),
  reference   TEXT        UNIQUE NOT NULL,
  amount      NUMERIC     NOT NULL DEFAULT 300.00,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_match     ON public.payments(match_id);
CREATE INDEX IF NOT EXISTS idx_payments_user      ON public.payments(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_reference ON public.payments(reference);

-- ----------------------------------------------------------------------------
-- 5. HELPER FUNCTION: generate_display_code()
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_display_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count BIGINT;
  v_code  TEXT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.profiles;
  v_code := 'RM' || LPAD((v_count + 101)::TEXT, 3, '0');
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE display_code = v_code) LOOP
    v_count := v_count + 1;
    v_code := 'RM' || LPAD((v_count + 101)::TEXT, 3, '0');
  END LOOP;
  RETURN v_code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_display_code() TO authenticated, anon, service_role;

-- ----------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 7. STORAGE BUCKET: kyc-documents (private)
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kyc-documents',
  'kyc-documents',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
