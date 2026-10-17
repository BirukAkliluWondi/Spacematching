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
