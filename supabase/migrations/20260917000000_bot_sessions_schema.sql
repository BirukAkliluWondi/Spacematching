-- Migration: Bot Sessions and Orders deep link support
BEGIN;

CREATE TABLE IF NOT EXISTS public.bot_sessions (
    telegram_id BIGINT PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    step TEXT NOT NULL DEFAULT 'idle',
    draft_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    session_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_sessions_telegram_id ON public.bot_sessions(telegram_id);

ALTER TABLE public.bot_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins have full access to bot_sessions" ON public.bot_sessions;
CREATE POLICY "Admins have full access to bot_sessions"
ON public.bot_sessions
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMIT;
