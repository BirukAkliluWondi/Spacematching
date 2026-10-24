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
  display_code?: string;
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
  listing_category?: string;
  space_type?: string;
  space_rent?: number;
  space_share?: number;
  space_amenities?: string[];
  space_photos?: string[];
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
  const current = getSession(telegramId);
  const preservedDraft: Record<string, any> = {};
  if (current?.draft_data?.checkin_scheduled) {
    preservedDraft.checkin_scheduled = true;
    preservedDraft.checkin_due = current.draft_data.checkin_due;
    preservedDraft.target_display_code = current.draft_data.target_display_code;
    preservedDraft.target_channel_message_id = current.draft_data.target_channel_message_id;
  }
  await saveSession({
    telegram_id: telegramId,
    step: 'idle',
    draft_data: preservedDraft,
    updated_at: new Date().toISOString(),
  });
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

// ---------------------------------------------------------------------------
// Managed Channels — Dynamic Multi-Channel Support
// ---------------------------------------------------------------------------
export interface ManagedChannel {
  channel_id: string | number; // e.g. "-1001234567890" or "@roommatch_addis"
  channel_title: string;
  channel_username: string | null;
  added_by?: number;
  is_active: boolean;
  added_at: string;
  updated_at: string;
}

const MANAGED_CHANNELS_SESSION_ID = -999999;
let cachedManagedChannels: ManagedChannel[] | null = null;
let managedChannelsCacheTime = 0;

export async function getManagedChannels(): Promise<ManagedChannel[]> {
  const now = Date.now();
  if (cachedManagedChannels && now - managedChannelsCacheTime < 60000) {
    return cachedManagedChannels;
  }

  try {
    const { data } = await supabase
      .from('bot_sessions')
      .select('draft_data')
      .eq('telegram_id', MANAGED_CHANNELS_SESSION_ID)
      .maybeSingle();

    if (data && data.draft_data && Array.isArray(data.draft_data.channels)) {
      cachedManagedChannels = data.draft_data.channels;
      managedChannelsCacheTime = now;
      return cachedManagedChannels!;
    }
  } catch (err) {
    console.error('getManagedChannels error:', err);
  }

  // Fallback default from environment if available
  const defaultChannel = process.env.TELEGRAM_CHANNEL_ID || '@roommatch_addis';
  const defaults: ManagedChannel[] = [
    {
      channel_id: defaultChannel,
      channel_title: 'SpaceMatch Addis Default',
      channel_username: defaultChannel.startsWith('@') ? defaultChannel : null,
      is_active: true,
      added_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  cachedManagedChannels = defaults;
  managedChannelsCacheTime = now;
  return defaults;
}

export async function saveManagedChannel(channel: ManagedChannel): Promise<void> {
  try {
    const current = await getManagedChannels();
    const existingIndex = current.findIndex(
      (c) =>
        String(c.channel_id) === String(channel.channel_id) ||
        (channel.channel_username && c.channel_username && c.channel_username.toLowerCase() === channel.channel_username.toLowerCase())
    );

    let updated: ManagedChannel[];
    if (existingIndex >= 0) {
      updated = [...current];
      updated[existingIndex] = { ...updated[existingIndex], ...channel, updated_at: new Date().toISOString() };
    } else {
      updated = [...current.filter(c => c.channel_id !== '@roommatch_addis' || c.added_by), channel];
    }

    cachedManagedChannels = updated;
    managedChannelsCacheTime = Date.now();

    await supabase.from('bot_sessions').upsert({
      telegram_id: MANAGED_CHANNELS_SESSION_ID,
      step: 'managed_channels',
      draft_data: { channels: updated },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'telegram_id' });
  } catch (err) {
    console.error('saveManagedChannel error:', err);
  }
}

export async function removeManagedChannel(channelId: string | number): Promise<void> {
  try {
    const current = await getManagedChannels();
    const updated = current.map((c) =>
      String(c.channel_id) === String(channelId) ||
      (c.channel_username && String(channelId).toLowerCase() === c.channel_username.toLowerCase())
        ? { ...c, is_active: false, updated_at: new Date().toISOString() }
        : c
    );

    cachedManagedChannels = updated;
    managedChannelsCacheTime = Date.now();

    await supabase.from('bot_sessions').upsert({
      telegram_id: MANAGED_CHANNELS_SESSION_ID,
      step: 'managed_channels',
      draft_data: { channels: updated },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'telegram_id' });
  } catch (err) {
    console.error('removeManagedChannel error:', err);
  }
}

