-- Per-post match tracking so a declined request on an older channel post
-- never permanently blocks a user from connecting on a brand-new post.
-- Note: TypeScript backend works safely before or after applying this migration.

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS target_display_code TEXT,
  ADD COLUMN IF NOT EXISTS target_channel_message_id BIGINT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill updated_at for existing rows so timestamp comparisons stay consistent
UPDATE public.matches
SET updated_at = COALESCE(completed_at, created_at, now())
WHERE updated_at IS NULL;

-- Drop strict pair-only uniqueness so declined/stale matches on older posts can be cleanly replaced or tracked
ALTER TABLE public.matches
  DROP CONSTRAINT IF EXISTS uq_match_pair;

-- Composite index for fast per-pair + status + listing lookups
CREATE INDEX IF NOT EXISTS idx_matches_pair_status
  ON public.matches (requester_id, target_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_matches_pair_code
  ON public.matches (requester_id, target_id, target_display_code);
