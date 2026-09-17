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
        CREATE TYPE public.fayda_status AS ENUM ('pending', 'verified', 'rejected');
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
