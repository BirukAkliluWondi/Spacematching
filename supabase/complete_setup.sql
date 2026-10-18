-- ========================================================
-- MASTER SUPABASE SETUP FOR SPACEMATCH ADDIS
-- Generated for easy single-step database setup
-- ========================================================


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- MIGRATION: supabase/migrations/20260916000000_peer_to_peer_room_rental_schema.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- ============================================================================
-- SUPABASE MIGRATION SCRIPT: Telegram-Only Curated Room Rental Mini App
-- Architecture: Zero-Trust Security Architecture with Row Level Security (RLS)
-- Author: Principal Database Architect
-- Date: 2026-09-16
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. EXTENSIONS & SCHEMA CLEANUP
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Drop existing views and tables to prevent legacy column collision (e.g. renter_id vs renter_telegram_id)
DROP VIEW IF EXISTS public.public_spaces_view CASCADE;
DROP TABLE IF EXISTS public.orders CASCADE;
DROP TABLE IF EXISTS public.space_images CASCADE;
DROP TABLE IF EXISTS public.spaces CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;

-- ----------------------------------------------------------------------------
-- 1. ENUM TYPES CREATION
-- ----------------------------------------------------------------------------
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE public.user_role AS ENUM ('renter', 'admin');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fayda_status') THEN
        CREATE TYPE public.fayda_status AS ENUM ('unverified', 'pending', 'verified', 'rejected');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'space_status') THEN
        CREATE TYPE public.space_status AS ENUM ('published', 'rented', 'archived');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
        CREATE TYPE public.payment_status AS ENUM ('pending', 'completed', 'failed');
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. TABLES CREATION
-- ----------------------------------------------------------------------------

-- 2.1 USERS TABLE
CREATE TABLE public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT,
    username TEXT,
    phone_number TEXT,
    role public.user_role NOT NULL DEFAULT 'renter',
    fayda_url TEXT,
    fayda_status public.fayda_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_users_telegram_id ON public.users(telegram_id);
CREATE INDEX idx_users_role ON public.users(role);

-- 2.2 SPACES TABLE
-- Homeowners DO NOT post directly. Spaces curated and created strictly by Admins.
CREATE TABLE public.spaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    price_per_month NUMERIC(10, 2) NOT NULL CHECK (price_per_month >= 0),
    unlock_fee NUMERIC(10, 2) NOT NULL DEFAULT 50.00 CHECK (unlock_fee >= 0),
    neighborhood TEXT NOT NULL,
    exact_address TEXT NOT NULL,
    latitude DECIMAL(10, 7) CHECK (latitude BETWEEN -90 AND 90),
    longitude DECIMAL(11, 7) CHECK (longitude BETWEEN -180 AND 180),
    amenities TEXT[] DEFAULT '{}'::TEXT[],
    rules TEXT[] DEFAULT '{}'::TEXT[],
    status public.space_status NOT NULL DEFAULT 'published',
    contact_name TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    contact_telegram TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_spaces_status ON public.spaces(status);
CREATE INDEX idx_spaces_neighborhood ON public.spaces(neighborhood);

-- 2.3 SPACE IMAGES TABLE
CREATE TABLE public.space_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    space_id UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
    image_path TEXT NOT NULL,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_space_images_space_id ON public.space_images(space_id);
CREATE INDEX idx_space_images_order ON public.space_images(space_id, display_order);

-- 2.4 ORDERS TABLE
CREATE TABLE public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    renter_telegram_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE RESTRICT,
    space_id UUID NOT NULL REFERENCES public.spaces(id) ON DELETE RESTRICT,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount >= 0),
    transaction_reference VARCHAR(255) UNIQUE,
    payment_status public.payment_status NOT NULL DEFAULT 'pending',
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_orders_transaction_reference ON public.orders(transaction_reference) WHERE transaction_reference IS NOT NULL;
CREATE INDEX idx_orders_renter_telegram_id ON public.orders(renter_telegram_id);
CREATE INDEX idx_orders_space_id ON public.orders(space_id);
CREATE INDEX idx_orders_renter_space_status ON public.orders(renter_telegram_id, space_id, payment_status);

-- ----------------------------------------------------------------------------
-- 3. AUTOMATIC TIMESTAMP TRIGGER FUNCTION
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_users_updated_at ON public.users;
CREATE TRIGGER trigger_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_spaces_updated_at ON public.spaces;
CREATE TRIGGER trigger_spaces_updated_at
    BEFORE UPDATE ON public.spaces
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_orders_updated_at ON public.orders;
CREATE TRIGGER trigger_orders_updated_at
    BEFORE UPDATE ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. ZERO-TRUST SECURITY VIEWS
-- ----------------------------------------------------------------------------
-- Public Spaces View: Curated summary visible to unauthenticated / standard renters.
-- Strictly excludes: exact_address, latitude, longitude, contact_phone, and contact_telegram.
-- Includes: unlock_fee and aggregated space_images JSON array.
CREATE OR REPLACE VIEW public.public_spaces_view
WITH (security_invoker = true)
AS
SELECT 
    s.id,
    s.title,
    s.description,
    s.price_per_month,
    s.unlock_fee,
    s.neighborhood,
    s.amenities,
    s.rules,
    s.status,
    s.contact_name,
    s.created_at,
    COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', img.id,
                'image_path', img.image_path,
                'display_order', img.display_order
            ) ORDER BY img.display_order ASC
        ) FILTER (WHERE img.id IS NOT NULL),
        '[]'::jsonb
    ) AS space_images
FROM public.spaces s
LEFT JOIN public.space_images img ON img.space_id = s.id
WHERE s.status = 'published'
GROUP BY s.id;

-- ----------------------------------------------------------------------------
-- 5. ZERO-TRUST POSTGRES SECURITY FUNCTIONS
-- ----------------------------------------------------------------------------

-- Helper function to check if current executing context is an admin user
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.users
    WHERE (
      id = auth.uid() 
      OR telegram_id::text = (auth.jwt() ->> 'telegram_id')
      OR telegram_id::text = (auth.jwt() ->> 'sub')
    )
    AND role = 'admin'
  );
$$;

-- Secure Postgres Function: get_unlocked_space_details
-- Validates that the renter (p_telegram_id) has a completed order for p_space_id OR is an admin.
-- Returns exact_address, latitude, longitude, contact_name, contact_phone, and contact_telegram.
CREATE OR REPLACE FUNCTION public.get_unlocked_space_details(
    p_space_id UUID,
    p_telegram_id BIGINT
)
RETURNS TABLE (
    exact_address TEXT,
    latitude DECIMAL(10, 7),
    longitude DECIMAL(11, 7),
    contact_name TEXT,
    contact_phone TEXT,
    contact_telegram TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_is_authorized BOOLEAN;
BEGIN
    -- 1. Check if user is admin OR has a completed order for this space
    SELECT EXISTS (
        SELECT 1
        FROM public.users u
        WHERE u.telegram_id = p_telegram_id
          AND u.role = 'admin'
    ) OR EXISTS (
        SELECT 1
        FROM public.orders o
        WHERE o.space_id = p_space_id
          AND o.renter_telegram_id = p_telegram_id
          AND o.payment_status = 'completed'
    ) INTO v_is_authorized;

    IF NOT v_is_authorized THEN
        RAISE EXCEPTION 'Authorization Error: Access denied. No completed payment order found for Space % and Telegram ID %.', p_space_id, p_telegram_id
            USING ERRCODE = '42501';
    END IF;

    -- 2. Return unlocked sensitive contact & geographic coordinates
    RETURN QUERY
    SELECT 
        s.exact_address,
        s.latitude,
        s.longitude,
        s.contact_name,
        s.contact_phone,
        s.contact_telegram
    FROM public.spaces s
    WHERE s.id = p_space_id;
END;
$$;

-- Grant execution to authenticated & anon roles
GRANT EXECUTE ON FUNCTION public.get_unlocked_space_details(UUID, BIGINT) TO authenticated, anon;

-- ----------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY (RLS) POLICIES
-- ----------------------------------------------------------------------------

-- Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.space_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- 6.1 RLS POLICIES: USERS
DROP POLICY IF EXISTS "Admins have full access to users" ON public.users;
CREATE POLICY "Admins have full access to users"
ON public.users
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Users can view their own profile" ON public.users;
CREATE POLICY "Users can view their own profile"
ON public.users
FOR SELECT
TO authenticated, anon
USING (
    id = auth.uid() 
    OR telegram_id::text = (auth.jwt() ->> 'telegram_id')
    OR telegram_id::text = (auth.jwt() ->> 'sub')
);

DROP POLICY IF EXISTS "Users can create their own profile" ON public.users;
CREATE POLICY "Users can create their own profile"
ON public.users
FOR INSERT
TO authenticated, anon
WITH CHECK (true);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.users;
CREATE POLICY "Users can update their own profile"
ON public.users
FOR UPDATE
TO authenticated, anon
USING (
    id = auth.uid() 
    OR telegram_id::text = (auth.jwt() ->> 'telegram_id')
)
WITH CHECK (
    id = auth.uid() 
    OR telegram_id::text = (auth.jwt() ->> 'telegram_id')
);

-- 6.2 RLS POLICIES: SPACES
-- Homeowners DO NOT post directly. Spaces created/modified ONLY by Admins.
DROP POLICY IF EXISTS "Admins have full write access to spaces" ON public.spaces;
CREATE POLICY "Admins have full write access to spaces"
ON public.spaces
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Public can view published spaces" ON public.spaces;
CREATE POLICY "Public can view published spaces"
ON public.spaces
FOR SELECT
TO public
USING (status = 'published');

-- 6.3 RLS POLICIES: SPACE IMAGES
DROP POLICY IF EXISTS "Admins have full access to space images" ON public.space_images;
CREATE POLICY "Admins have full access to space images"
ON public.space_images
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Public can view images for published spaces" ON public.space_images;
CREATE POLICY "Public can view images for published spaces"
ON public.space_images
FOR SELECT
TO public
USING (
    EXISTS (
        SELECT 1 FROM public.spaces s
        WHERE s.id = space_images.space_id
          AND s.status = 'published'
    )
);

-- 6.4 RLS POLICIES: ORDERS
DROP POLICY IF EXISTS "Admins have full access to orders" ON public.orders;
CREATE POLICY "Admins have full access to orders"
ON public.orders
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Renters can view their own orders" ON public.orders;
CREATE POLICY "Renters can view their own orders"
ON public.orders
FOR SELECT
TO authenticated, anon
USING (
    renter_telegram_id::text = (auth.jwt() ->> 'telegram_id')
    OR renter_telegram_id::text = (auth.jwt() ->> 'sub')
    OR renter_telegram_id IN (
        SELECT u.telegram_id FROM public.users u WHERE u.id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Renters can submit pending orders" ON public.orders;
CREATE POLICY "Renters can submit pending orders"
ON public.orders
FOR INSERT
TO authenticated, anon
WITH CHECK (
    payment_status = 'pending'
    AND (
        renter_telegram_id::text = (auth.jwt() ->> 'telegram_id')
        OR renter_telegram_id::text = (auth.jwt() ->> 'sub')
        OR renter_telegram_id IN (
            SELECT u.telegram_id FROM public.users u WHERE u.id = auth.uid()
        )
    )
);

-- ----------------------------------------------------------------------------
-- 7. SUPABASE STORAGE BUCKETS & RLS POLICIES
-- ----------------------------------------------------------------------------

-- Ensure storage schema & buckets table exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
    (
        'spaces-public', 
        'spaces-public', 
        true, 
        10485760, -- 10MB limit
        ARRAY['image/jpeg', 'image/png', 'image/webp']
    ),
    (
        'fayda-ids', 
        'fayda-ids', 
        false, -- STRICTLY PRIVATE
        10485760, -- 10MB limit
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    )
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 7.1 STORAGE POLICIES: 'spaces-public' (Readable by anyone, writable by admins)
DROP POLICY IF EXISTS "Public Read Access for spaces-public" ON storage.objects;
CREATE POLICY "Public Read Access for spaces-public"
ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'spaces-public');

DROP POLICY IF EXISTS "Admin Insert Access for spaces-public" ON storage.objects;
CREATE POLICY "Admin Insert Access for spaces-public"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'spaces-public' AND public.is_admin());

DROP POLICY IF EXISTS "Admin Update Access for spaces-public" ON storage.objects;
CREATE POLICY "Admin Update Access for spaces-public"
ON storage.objects
FOR UPDATE
TO authenticated
USING (bucket_id = 'spaces-public' AND public.is_admin());

DROP POLICY IF EXISTS "Admin Delete Access for spaces-public" ON storage.objects;
CREATE POLICY "Admin Delete Access for spaces-public"
ON storage.objects
FOR DELETE
TO authenticated
USING (bucket_id = 'spaces-public' AND public.is_admin());

-- 7.2 STORAGE POLICIES: 'fayda-ids' (Strictly private; accessible via signed URLs or admins)
-- Renters can upload their own identity documents
DROP POLICY IF EXISTS "Renters can upload Fayda ID" ON storage.objects;
CREATE POLICY "Renters can upload Fayda ID"
ON storage.objects
FOR INSERT
TO authenticated, anon
WITH CHECK (bucket_id = 'fayda-ids');

-- Only Admins can directly read/list objects from the private fayda-ids bucket
DROP POLICY IF EXISTS "Admin Read Access for fayda-ids" ON storage.objects;
CREATE POLICY "Admin Read Access for fayda-ids"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'fayda-ids' AND public.is_admin());

-- Only Admins can delete from fayda-ids bucket
DROP POLICY IF EXISTS "Admin Delete Access for fayda-ids" ON storage.objects;
CREATE POLICY "Admin Delete Access for fayda-ids"
ON storage.objects
FOR DELETE
TO authenticated
USING (bucket_id = 'fayda-ids' AND public.is_admin());

COMMIT;



-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- MIGRATION: supabase/migrations/20261010000000_roommate_primary_schema.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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



-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- MIGRATION: supabase/migrations/20261016_telegram_schema.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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



-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- MIGRATION: supabase/migrations/20261018_bot_sessions.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- Bot Sessions table (replaces filesystem-based session store)
-- Needed because Vercel serverless instances don't share a filesystem.
create table if not exists bot_sessions (
  telegram_id text primary key,
  step text not null default 'idle',
  draft_data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- Pending space drafts (previously stored in data/pending_space_drafts.json)
create table if not exists pending_space_drafts (
  id text primary key,
  homeowner_telegram_id bigint,
  homeowner_name text,
  homeowner_username text,
  title text,
  neighborhood text,
  price_per_month numeric,
  description text,
  exact_address text,
  contact_phone text,
  owner_gender text,
  preferred_tenant_gender text,
  photo_file_id text,
  photo_url text,
  status text default 'pending',
  rejection_reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Pending roommate profile drafts (previously stored in data/pending_roommate_drafts.json)
create table if not exists pending_roommate_drafts (
  id text primary key,
  user_telegram_id bigint,
  user_name text,
  username text,
  preferred_subcity jsonb default '[]',
  my_gender text,
  preferred_gender text,
  budget_min numeric default 0,
  budget_max numeric default 10000,
  lifestyle_bio text,
  fayda_status text default 'unverified',
  fayda_document_url text,
  unlock_fee numeric default 50,
  status text default 'pending_approval',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Allow service role full access (webhook uses service role key)
alter table bot_sessions enable row level security;
alter table pending_space_drafts enable row level security;
alter table pending_roommate_drafts enable row level security;

create policy "service_role_all" on bot_sessions for all using (true);
create policy "service_role_all" on pending_space_drafts for all using (true);
create policy "service_role_all" on pending_roommate_drafts for all using (true);


