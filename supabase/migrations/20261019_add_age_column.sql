-- Add age and channel_message_id columns if they do not already exist
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE public.roommate_profiles ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE public.roommate_profiles ADD COLUMN IF NOT EXISTS channel_message_id BIGINT;
ALTER TABLE public.spaces ADD COLUMN IF NOT EXISTS channel_message_id BIGINT;

ALTER TABLE public.pending_roommate_drafts ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE public.pending_roommate_drafts ADD COLUMN IF NOT EXISTS channel_message_id BIGINT;

ALTER TABLE public.pending_space_drafts ADD COLUMN IF NOT EXISTS channel_message_id BIGINT;
