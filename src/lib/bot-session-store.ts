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
  job?: string;
  religion?: string;
  preferred_subcity: string[];
  my_gender: 'Male' | 'Female' | string;
  preferred_gender: 'Male' | 'Female' | 'Any' | string;
  budget_min: number;
  budget_max: number;
  lifestyle_bio: string;
  preferred_roommate?: string;
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
  const cachedLang = _userLanguageCache[String(telegramId)];
  return {
    telegram_id: telegramId,
    step: 'idle',
    draft_data: cachedLang ? { lang: cachedLang } : {},
    updated_at: new Date().toISOString(),
  };
}

// In-memory cache per serverless invocation (populated by preloadSession)
const _sessionCache: Record<string, BotSession> = {};
const _userLanguageCache: Record<string, 'am' | 'en'> = {};

export function getUserLanguage(telegramId: number): 'am' | 'en' | undefined {
  return _userLanguageCache[String(telegramId)] || (_sessionCache[String(telegramId)]?.draft_data?.lang as ('am' | 'en') | undefined);
}

export function setUserLanguage(telegramId: number, lang: 'am' | 'en'): void {
  _userLanguageCache[String(telegramId)] = lang;
  if (_sessionCache[String(telegramId)]) {
    _sessionCache[String(telegramId)].draft_data = {
      ..._sessionCache[String(telegramId)].draft_data,
      lang,
    };
  }
}

// ---------------------------------------------------------------------------
// Session CRUD — stored in `bot_sessions` Supabase table
// ---------------------------------------------------------------------------
export function getSession(telegramId: number): BotSession {
  // NOTE: Supabase JS v2 requires async, but the old code was sync.
  // We keep the sync interface here and use a module-level in-memory cache
  // that is populated by the async preload below. Call preloadSession() first.
  const sess = _sessionCache[String(telegramId)] ?? emptySession(telegramId);
  const userLang = _userLanguageCache[String(telegramId)];
  if (userLang && !sess.draft_data?.lang) {
    sess.draft_data = { ...sess.draft_data, lang: userLang };
  }
  return sess;
}

/** Call this at the top of the webhook handler BEFORE calling getSession(). */
export async function preloadSession(telegramId: number): Promise<BotSession> {
  const cached = _sessionCache[String(telegramId)];
  if (cached) {
    if (cached.draft_data?.lang) {
      _userLanguageCache[String(telegramId)] = cached.draft_data.lang;
    } else if (_userLanguageCache[String(telegramId)]) {
      cached.draft_data.lang = _userLanguageCache[String(telegramId)];
    }
    return cached;
  }
  try {
    const { data } = await supabase
      .from('bot_sessions')
      .select('*')
      .eq('telegram_id', String(telegramId))
      .maybeSingle();

    const session: BotSession = data
      ? {
          telegram_id: Number(data.telegram_id),
          step: data.step ?? 'idle',
          draft_data: data.draft_data ?? {},
          updated_at: data.updated_at,
        }
      : emptySession(telegramId);

    if (session.draft_data?.lang) {
      _userLanguageCache[String(telegramId)] = session.draft_data.lang;
    } else if (_userLanguageCache[String(telegramId)]) {
      session.draft_data.lang = _userLanguageCache[String(telegramId)];
    }

    _sessionCache[String(telegramId)] = session;
    return session;
  } catch {
    const session = emptySession(telegramId);
    _sessionCache[String(telegramId)] = session;
    return session;
  }
}

// Per-user write queue to guarantee database persistence ordering without blocking webhook responses
const _sessionWriteQueues: Record<string, Promise<any>> = {};

export async function saveSession(session: BotSession, awaitDb = false): Promise<void> {
  // Ensure draft_data is an object and retains language
  session.draft_data = session.draft_data ?? {};
  const activeLang = session.draft_data.lang || _userLanguageCache[String(session.telegram_id)];
  if (activeLang) {
    session.draft_data.lang = activeLang;
    _userLanguageCache[String(session.telegram_id)] = activeLang;
  }

  // 1. In-memory cache is updated IMMEDIATELY (0ms latency for subsequent gets)
  _sessionCache[String(session.telegram_id)] = session;

  // 2. Database write is queued in background to avoid blocking the webhook lifecycle
  const persistTask = async () => {
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
  };

  const idStr = String(session.telegram_id);
  const prev = _sessionWriteQueues[idStr] || Promise.resolve();
  const next = prev.then(persistTask, persistTask).finally(() => {
    if (_sessionWriteQueues[idStr] === next) {
      delete _sessionWriteQueues[idStr];
    }
  });
  _sessionWriteQueues[idStr] = next;

  if (awaitDb) {
    await next;
  }
}

export async function clearSession(telegramId: number): Promise<void> {
  const current = getSession(telegramId);
  const preservedDraft: Record<string, any> = {};
  const activeLang = current?.draft_data?.lang || _userLanguageCache[String(telegramId)];
  if (activeLang) {
    preservedDraft.lang = activeLang;
    _userLanguageCache[String(telegramId)] = activeLang;
  }
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
      .maybeSingle();
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
// Roommate Profile Drafts — stored in `pending_roommate_drafts` + in-memory & session fallback
// ---------------------------------------------------------------------------
const _roommateDraftsCache = new Map<string, RoommateProfileDraft>();

export async function saveRoommateDraft(draft: RoommateProfileDraft): Promise<void> {
  const cleanId = (draft.id || '').trim();
  const cleanCode = (draft.display_code || cleanId).trim();

  // 1. In-memory cache for ultra-fast zero-fail retrieval
  if (cleanId) _roommateDraftsCache.set(cleanId.toLowerCase(), draft);
  if (cleanCode) _roommateDraftsCache.set(cleanCode.toLowerCase(), draft);
  if (draft.user_telegram_id) {
    _roommateDraftsCache.set(String(draft.user_telegram_id), draft);
  }

  // 2. Persist to bot_sessions draft_data so photos and space metadata survive restarts
  if (draft.user_telegram_id) {
    try {
      const session = getSession(draft.user_telegram_id);
      session.draft_data = {
        ...(session.draft_data || {}),
        ...draft,
        display_code: cleanCode,
      };
      await saveSession(session);
    } catch (sErr) {
      console.warn('[saveRoommateDraft] bot_sessions update error:', sErr);
    }
  }

  // 3. Upsert into pending_roommate_drafts with ONLY valid DB columns to prevent PostgreSQL schema cache errors
  try {
    const validDbPayload = {
      id: cleanId,
      user_telegram_id: draft.user_telegram_id,
      user_name: draft.user_name || 'Roommate Seeker',
      username: draft.username || null,
      preferred_subcity: Array.isArray(draft.preferred_subcity) ? draft.preferred_subcity : [],
      my_gender: draft.my_gender || 'Member',
      preferred_gender: draft.preferred_gender || 'Any',
      budget_min: Number(draft.budget_min || 0),
      budget_max: Number(draft.budget_max || 10000),
      lifestyle_bio: draft.lifestyle_bio || '',
      fayda_status: draft.fayda_status || 'verified',
      fayda_document_url: draft.fayda_document_url || null,
      unlock_fee: Number(draft.unlock_fee || 300),
      status: draft.status || 'pending_approval',
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('pending_roommate_drafts')
      .upsert(validDbPayload, { onConflict: 'id' });
    if (error) console.warn('[saveRoommateDraft] DB upsert warning:', error.message);
  } catch (err) {
    console.warn('[saveRoommateDraft] DB exception:', err);
  }
}

export async function getRoommateDraft(draftId: string): Promise<RoommateProfileDraft | null> {
  const cleanId = (draftId || '').trim().toLowerCase();

  // 1. Check in-memory cache first
  if (_roommateDraftsCache.has(cleanId)) {
    return _roommateDraftsCache.get(cleanId)!;
  }

  // 2. Try pending_roommate_drafts table
  let dbDraft: any = null;
  try {
    const { data } = await supabase
      .from('pending_roommate_drafts')
      .select('*')
      .eq('id', draftId)
      .maybeSingle();
    if (data) dbDraft = data;
  } catch {}

  // 3. Check in-memory session cache first, then single-row DB fallback
  try {
    const last4 = cleanId.replace(/^rm/i, '');
    let match: any = null;

    // Fast check inside in-memory _sessionCache (0ms)
    for (const s of Object.values(_sessionCache)) {
      const d = s.draft_data || {};
      const code = (d.display_code || '').toLowerCase();
      const tgStr = String(s.telegram_id || '');
      if (
        code === cleanId ||
        code === `rm${last4}` ||
        tgStr === cleanId ||
        (last4.length >= 3 && tgStr.endsWith(last4))
      ) {
        match = s;
        break;
      }
    }

    // Targeted single-row lookup instead of full table scan
    if (!match) {
      const tgNum = Number(cleanId);
      if (!isNaN(tgNum) && tgNum > 0) {
        const { data: s } = await supabase
          .from('bot_sessions')
          .select('*')
          .eq('telegram_id', tgNum)
          .maybeSingle();
        if (s) match = s;
      }
      if (!match) {
        const { data: s } = await supabase
          .from('bot_sessions')
          .select('*')
          .filter('draft_data->>display_code', 'ilike', cleanId)
          .limit(1)
          .maybeSingle();
        if (s) match = s;
      }
    }

    if (match && match.draft_data) {
      const d = match.draft_data;
      const mergedDraft: RoommateProfileDraft = {
        id: d.display_code || dbDraft?.id || draftId,
        display_code: d.display_code || dbDraft?.id || draftId,
        user_telegram_id: Number(match.telegram_id || dbDraft?.user_telegram_id),
        user_name: d.user_name || dbDraft?.user_name || 'Verified Member',
        username: d.username || dbDraft?.username || null,
        age: d.age || 24,
        job: d.job || dbDraft?.job,
        religion: d.religion || dbDraft?.religion,
        my_gender: d.gender || d.my_gender || dbDraft?.my_gender || 'Member',
        preferred_gender: d.preferred_gender || dbDraft?.preferred_gender || 'Any',
        preferred_subcity: d.preferred_subcity || dbDraft?.preferred_subcity || [d.location || 'Addis Ababa'],
        budget_min: Number(d.space_share || d.budget_min || dbDraft?.budget_min || 0),
        budget_max: Number(d.space_rent || d.budget_max || dbDraft?.budget_max || 10000),
        lifestyle_bio: d.roommate_traits || d.lifestyle_bio || dbDraft?.lifestyle_bio || 'Roommate listing in Addis Ababa.',
        listing_category: d.listing_category || (d.space_rent ? 'space_available' : 'seeker'),
        space_type: d.space_type || 'Private Bedroom in Shared Flat',
        space_rent: d.space_rent ? Number(d.space_rent) : undefined,
        space_share: d.space_share ? Number(d.space_share) : undefined,
        space_amenities: d.space_amenities || [],
        space_photos: d.space_photos || [],
        unlock_fee: 300,
        fayda_status: 'verified',
        status: 'pending_approval',
        created_at: dbDraft?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      _roommateDraftsCache.set(cleanId, mergedDraft);
      return mergedDraft;
    }
  } catch (err) {
    console.warn('[getRoommateDraft] bot_sessions fallback error:', err);
  }

  if (dbDraft) {
    _roommateDraftsCache.set(cleanId, dbDraft);
    return dbDraft;
  }

  return null;
}

export async function getAllRoommateDrafts(): Promise<Record<string, RoommateProfileDraft>> {
  const result: Record<string, RoommateProfileDraft> = {};

  try {
    const { data } = await supabase.from('pending_roommate_drafts').select('*');
    if (data && Array.isArray(data)) {
      data.forEach((d: any) => {
        result[d.id] = d;
      });
    }
  } catch {}

  // Merge in-memory drafts
  for (const [k, v] of _roommateDraftsCache.entries()) {
    if (v && v.id) {
      result[v.id] = { ...(result[v.id] || {}), ...v };
    }
  }

  return result;
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
  if (cachedManagedChannels && now - managedChannelsCacheTime < 15 * 60 * 1000) {
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
  const defaultChannel = process.env.TELEGRAM_CHANNEL_ID || '@roommate_addis';
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
      updated = [...current.filter(c => c.channel_id !== '@roommate_addis' || c.added_by), channel];
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

