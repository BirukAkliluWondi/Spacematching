-- ============================================================================
-- SUPABASE MIGRATION SCRIPT: Roommate Primary Matching & Housing Ecosystem
-- Architecture: Zero-Trust Security Architecture with Row Level Security (RLS)
-- Date: 2026-10-10
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. ENUM TYPES CREATION
-- ----------------------------------------------------------------------------
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fayda_status') THEN
        CREATE TYPE public.fayda_status AS ENUM ('unverified', 'pending', 'verified', 'rejected');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'item_status') THEN
        CREATE TYPE public.item_status AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'archived');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
        CREATE TYPE public.payment_status AS ENUM ('pending', 'completed', 'failed');
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. USERS TABLE ENHANCEMENTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT,
    username TEXT,
    phone_number TEXT,
    gender TEXT CHECK (gender IN ('Male', 'Female')),
    fayda_id_number TEXT,
    fayda_document_url TEXT,
    fayda_status public.fayda_status NOT NULL DEFAULT 'unverified',
    fayda_verified_at TIMESTAMPTZ,
    role TEXT NOT NULL DEFAULT 'renter',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure columns exist if table was previously created
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS fayda_id_number TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS fayda_document_url TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS fayda_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON public.users(telegram_id);

-- ----------------------------------------------------------------------------
-- 3. ROOMMATE PROFILES TABLE (PRIMARY ENTITY)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.roommate_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_telegram_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
    preferred_subcity TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    my_gender TEXT NOT NULL CHECK (my_gender IN ('Male', 'Female')),
    preferred_gender TEXT NOT NULL CHECK (preferred_gender IN ('Male', 'Female', 'Any')),
    budget_min NUMERIC(10, 2) DEFAULT 0 CHECK (budget_min >= 0),
    budget_max NUMERIC(10, 2) NOT NULL CHECK (budget_max >= 0),
    lifestyle_bio TEXT,
    unlock_fee NUMERIC(10, 2) NOT NULL DEFAULT 50.00 CHECK (unlock_fee >= 0),
    status public.item_status NOT NULL DEFAULT 'pending_approval',
    is_paid_order BOOLEAN NOT NULL DEFAULT false,
    channel_message_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_roommate_profiles_status ON public.roommate_profiles(status);
CREATE INDEX IF NOT EXISTS idx_roommate_profiles_user ON public.roommate_profiles(user_telegram_id);

-- ----------------------------------------------------------------------------
-- 4. SPACE LISTINGS TABLE (SECONDARY ENTITY FOR HOMEOWNERS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.space_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_telegram_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    rent_price NUMERIC(10, 2) NOT NULL CHECK (rent_price >= 0),
    unlock_fee NUMERIC(10, 2) NOT NULL DEFAULT 50.00 CHECK (unlock_fee >= 0),
    subcity TEXT NOT NULL,
    exact_address TEXT,
    owner_gender TEXT,
    preferred_tenant_gender TEXT,
    images TEXT[] DEFAULT '{}'::TEXT[],
    status public.item_status NOT NULL DEFAULT 'pending_approval',
    channel_message_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_space_listings_status ON public.space_listings(status);
CREATE INDEX IF NOT EXISTS idx_space_listings_subcity ON public.space_listings(subcity);

-- ----------------------------------------------------------------------------
-- 5. ORDERS TABLE (CONTACT UNLOCKS & CHANNEL BOOSTS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_telegram_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE RESTRICT,
    order_type TEXT NOT NULL CHECK (order_type IN ('unlock_contact', 'channel_boost_order')),
    target_type TEXT NOT NULL CHECK (target_type IN ('roommate_profile', 'space_listing')),
    target_id UUID NOT NULL,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount >= 0),
    transaction_reference VARCHAR(255) UNIQUE,
    payment_status public.payment_status NOT NULL DEFAULT 'pending',
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_txn_ref ON public.orders(transaction_reference) WHERE transaction_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_buyer_telegram_id ON public.orders(buyer_telegram_id);

-- ----------------------------------------------------------------------------
-- 6. PUBLIC VIEWS (WITHOUT PRIVACY SENSITIVE CONTACT INFO)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.public_roommate_profiles_view
WITH (security_invoker = true)
AS
SELECT 
    rp.id,
    rp.user_telegram_id,
    u.first_name,
    u.fayda_status,
    rp.preferred_subcity,
    rp.my_gender,
    rp.preferred_gender,
    rp.budget_min,
    rp.budget_max,
    rp.lifestyle_bio,
    rp.unlock_fee,
    rp.status,
    rp.is_paid_order,
    rp.created_at
FROM public.roommate_profiles rp
JOIN public.users u ON u.telegram_id = rp.user_telegram_id
WHERE rp.status = 'approved';

CREATE OR REPLACE VIEW public.public_space_listings_view
WITH (security_invoker = true)
AS
SELECT 
    sl.id,
    sl.owner_telegram_id,
    u.first_name AS owner_first_name,
    u.fayda_status AS owner_fayda_status,
    sl.title,
    sl.description,
    sl.rent_price,
    sl.unlock_fee,
    sl.subcity,
    sl.owner_gender,
    sl.preferred_tenant_gender,
    sl.images,
    sl.status,
    sl.created_at
FROM public.space_listings sl
JOIN public.users u ON u.telegram_id = sl.owner_telegram_id
WHERE sl.status = 'approved';

-- ----------------------------------------------------------------------------
-- 7. ZERO-TRUST POSTGRES RPC SECURITY FUNCTIONS
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_unlocked_contact_details(
    p_target_id UUID,
    p_target_type TEXT,
    p_telegram_id BIGINT
)
RETURNS TABLE (
    contact_first_name TEXT,
    contact_phone TEXT,
    contact_username TEXT,
    fayda_status public.fayda_status,
    exact_detail TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_is_authorized BOOLEAN;
    v_owner_telegram_id BIGINT;
    v_detail TEXT;
BEGIN
    -- 1. Check if user is admin OR has a completed order for this target
    SELECT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.telegram_id = p_telegram_id AND u.role = 'admin'
    ) OR EXISTS (
        SELECT 1 FROM public.orders o
        WHERE o.target_id = p_target_id
          AND o.target_type = p_target_type
          AND o.buyer_telegram_id = p_telegram_id
          AND o.payment_status = 'completed'
    ) INTO v_is_authorized;

    IF NOT v_is_authorized THEN
        RAISE EXCEPTION 'Access Denied: Unlocking requires a verified payment order.'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Fetch owner telegram ID and detail
    IF p_target_type = 'roommate_profile' THEN
        SELECT user_telegram_id, lifestyle_bio INTO v_owner_telegram_id, v_detail
        FROM public.roommate_profiles WHERE id = p_target_id;
    ELSIF p_target_type = 'space_listing' THEN
        SELECT owner_telegram_id, exact_address INTO v_owner_telegram_id, v_detail
        FROM public.space_listings WHERE id = p_target_id;
    ELSE
        RAISE EXCEPTION 'Invalid target_type parameter';
    END IF;

    -- 3. Return unlocked contact information
    RETURN QUERY
    SELECT 
        u.first_name,
        u.phone_number,
        u.username,
        u.fayda_status,
        v_detail
    FROM public.users u
    WHERE u.telegram_id = v_owner_telegram_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_unlocked_contact_details(UUID, TEXT, BIGINT) TO authenticated, anon;

-- ----------------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY (RLS) POLICIES
-- ----------------------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roommate_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.space_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view approved roommate profiles view" ON public.roommate_profiles;
CREATE POLICY "Public can view approved roommate profiles view"
ON public.roommate_profiles FOR SELECT TO public USING (status = 'approved');

DROP POLICY IF EXISTS "Public can view approved space listings view" ON public.space_listings;
CREATE POLICY "Public can view approved space listings view"
ON public.space_listings FOR SELECT TO public USING (status = 'approved');

COMMIT;
