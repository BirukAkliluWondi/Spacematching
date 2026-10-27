-- ============================================================================
-- SUPABASE MIGRATION: Add religion, job, preferred_gender to profiles & roommate_profiles
-- Date: 2026-10-26
-- ============================================================================

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS religion TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS job TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS preferred_gender TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS age INTEGER;

ALTER TABLE public.roommate_profiles ADD COLUMN IF NOT EXISTS religion TEXT;
ALTER TABLE public.roommate_profiles ADD COLUMN IF NOT EXISTS job TEXT;
ALTER TABLE public.roommate_profiles ADD COLUMN IF NOT EXISTS preferred_gender TEXT;
ALTER TABLE public.roommate_profiles ADD COLUMN IF NOT EXISTS age INTEGER;

ALTER TABLE public.pending_roommate_drafts ADD COLUMN IF NOT EXISTS religion TEXT;
ALTER TABLE public.pending_roommate_drafts ADD COLUMN IF NOT EXISTS job TEXT;
ALTER TABLE public.pending_roommate_drafts ADD COLUMN IF NOT EXISTS preferred_gender TEXT;
ALTER TABLE public.pending_roommate_drafts ADD COLUMN IF NOT EXISTS age INTEGER;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS religion TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS job TEXT;
