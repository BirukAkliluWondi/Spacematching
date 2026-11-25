-- Optional SpaceMatch Production Hardening Migration
-- Apply in Supabase SQL Editor if you want database-level expression uniqueness & normalized lookup indexes.
-- Note: The TypeScript backend is already 100% compatible without requiring this script.

-- 1. Normalized case-insensitive uniqueness index for completed payment references (prevents replay even across mixed casing)
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_canonical_completed_txn_ref
  ON public.orders (UPPER(BTRIM(transaction_reference)))
  WHERE payment_status = 'completed' AND transaction_reference IS NOT NULL;

-- 2. Partial index for active 3-Month Pass lookups (accelerates getUserMembershipStatus)
CREATE INDEX IF NOT EXISTS idx_orders_buyer_completed_created
  ON public.orders (buyer_telegram_id, verified_at DESC, created_at DESC)
  WHERE payment_status = 'completed';

-- 3. Helpful indexes for pending approval queues & display code resolution
CREATE INDEX IF NOT EXISTS idx_profiles_status_step
  ON public.profiles (status, onboarding_step);

CREATE INDEX IF NOT EXISTS idx_pending_roommate_drafts_code
  ON public.pending_roommate_drafts (display_code)
  WHERE display_code IS NOT NULL;
