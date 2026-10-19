import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Supabase client (service role — safe for server-side only)
// ---------------------------------------------------------------------------
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface BotSession {
  telegram_id: number;
  step: string;
  draft_data: Record<string, any>;
  updated_at: string;
}

export interface RoommateProfileDraft {
  id: string;
  user_telegram_id: number;
  user_name: string;
  username: string | null;
  contact_phone?: string;
  age?: number;
  preferred_subcity: string[];
  my_gender: 'Male' | 'Female';
  preferred_gender: 'Male' | 'Female' | 'Any';
  budget_min: number;
  budget_max: number;
  lifestyle_bio: string;
  fayda_status: 'unverified' | 'pending' | 'verified' | 'rejected';
  fayda_document_url?: string | null;
  unlock_fee: number;
  channel_message_id?: number | null;
  status: 'pending_approval' | 'approved' | 'rejected' | 'matched';
  created_at: string;
  updated_at: string;
}

export interface SpaceDraft {
  id: string;
  homeowner_telegram_id: number;
  homeowner_name: string;
  homeowner_username: string | null;
  title: string;
  neighborhood: string;
  price_per_month: number;
  description: string;
  exact_address: string;
  contact_phone: string;
  owner_gender?: string;
  preferred_tenant_gender?: string;
  photo_file_id: string | null;
  photo_url: string | null;
  channel_message_id?: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'matched';
  rejection_reason?: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Empty session factory
// ---------------------------------------------------------------------------
function emptySession(telegramId: number): BotSession {
  return {
    telegram_id: telegramId,
    step: 'idle',
    draft_data: {},
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Session CRUD — stored in `bot_sessions` Supabase table
// ---------------------------------------------------------------------------
export function getSession(telegramId: number): BotSession {
  // NOTE: Supabase JS v2 requires async, but the old code was sync.
  // We keep the sync interface here and use a module-level in-memory cache
  // that is populated by the async preload below. Call preloadSession() first.
  return _sessionCache[String(telegramId)] ?? emptySession(telegramId);
}

// In-memory cache per serverless invocation (populated by preloadSession)
const _sessionCache: Record<string, BotSession> = {};

/** Call this at the top of the webhook handler BEFORE calling getSession(). */
export async function preloadSession(telegramId: number): Promise<BotSession> {
  try {
    const { data } = await supabase
      .from('bot_sessions')
      .select('*')
      .eq('telegram_id', String(telegramId))
      .single();

    const session: BotSession = data
      ? {
          telegram_id: Number(data.telegram_id),
          step: data.step ?? 'idle',
          draft_data: data.draft_data ?? {},
          updated_at: data.updated_at,
        }
      : emptySession(telegramId);

    _sessionCache[String(telegramId)] = session;
    return session;
  } catch {
    const session = emptySession(telegramId);
    _sessionCache[String(telegramId)] = session;
    return session;
  }
}

export async function saveSession(session: BotSession): Promise<void> {
  // Update cache immediately so subsequent getSession() calls in the same
  // request see the new state, then persist to Supabase and await.
  _sessionCache[String(session.telegram_id)] = session;

  try {
    const { error } = await supabase
      .from('bot_sessions')
      .upsert(
        {
          telegram_id: String(session.telegram_id),
          step: session.step,
          draft_data: session.draft_data,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'telegram_id' }
      );
    if (error) console.error('saveSession error:', error.message);
  } catch (err) {
    console.error('saveSession exception:', err);
  }
}

export async function clearSession(telegramId: number): Promise<void> {
  await saveSession(emptySession(telegramId));
}

// ---------------------------------------------------------------------------
// Space Drafts — stored in `pending_space_drafts` Supabase table
// ---------------------------------------------------------------------------
export async function saveDraft(draft: SpaceDraft): Promise<void> {
  try {
    const { error } = await supabase
      .from('pending_space_drafts')
      .upsert({ ...draft, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) console.error('saveDraft error:', error.message);
  } catch (err) {
    console.error('saveDraft exception:', err);
  }
}

export async function getDraft(draftId: string): Promise<SpaceDraft | null> {
  try {
    const { data } = await supabase
      .from('pending_space_drafts')
      .select('*')
      .eq('id', draftId)
      .single();
    return data ?? null;
  } catch {
    return null;
  }
}

export async function getAllSpaceDrafts(): Promise<Record<string, SpaceDraft>> {
  try {
    const { data } = await supabase.from('pending_space_drafts').select('*');
    if (!data) return {};
    return Object.fromEntries(data.map((d: SpaceDraft) => [d.id, d]));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Roommate Profile Drafts — stored in `pending_roommate_drafts` Supabase table
// ---------------------------------------------------------------------------
export async function saveRoommateDraft(draft: RoommateProfileDraft): Promise<void> {
  try {
    const { error } = await supabase
      .from('pending_roommate_drafts')
      .upsert({ ...draft, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) console.error('saveRoommateDraft error:', error.message);
  } catch (err) {
    console.error('saveRoommateDraft exception:', err);
  }
}

export async function getRoommateDraft(draftId: string): Promise<RoommateProfileDraft | null> {
  try {
    const { data } = await supabase
      .from('pending_roommate_drafts')
      .select('*')
      .eq('id', draftId)
      .single();
    return data ?? null;
  } catch {
    return null;
  }
}

export async function getAllRoommateDrafts(): Promise<Record<string, RoommateProfileDraft>> {
  try {
    const { data } = await supabase.from('pending_roommate_drafts').select('*');
    if (!data) return {};
    return Object.fromEntries(data.map((d: RoommateProfileDraft) => [d.id, d]));
  } catch {
    return {};
  }
}
