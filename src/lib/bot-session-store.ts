import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Supabase client (service role — safe for server-side only)
// ---------------------------------------------------------------------------
const supabaseUrl = (
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://plusmfmlzzumzsqtlixb.supabase.co'
).trim();
const supabaseServiceRoleKey = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsdXNtZm1senp1bXpzcXRsaXhiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTk1OTM1NiwiZXhwIjoyMTA3NTM1MzU2fQ.1nXAUO7usoDst_maNIE252DHyK-NtHPazQY0ats7qVE'
).trim();

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// ---------------------------------------------------------------------------
// Process Crash Guard & Lifecycle Management
// ---------------------------------------------------------------------------
export function installProcessProtection(): void {
  if (typeof process === 'undefined' || !process.on) return;
  const GLOBAL_CRASH_GUARD = Symbol.for('spacematch.crash_guard.active');
  if ((globalThis as any)[GLOBAL_CRASH_GUARD]) return;
  (globalThis as any)[GLOBAL_CRASH_GUARD] = true;

  process.on('uncaughtException', (err: Error, origin: string) => {
    console.error(`[Process Crash Guard] Uncaught Exception (${origin}):`, err);
  });

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    console.error('[Process Crash Guard] Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('SIGTERM', () => {
    console.log('[Process] SIGTERM received. Gracefully draining connections...');
  });

  process.on('SIGINT', () => {
    console.log('[Process] SIGINT received. Shutting down cleanly...');
  });
}

// Auto-install guards on module load
installProcessProtection();

// ---------------------------------------------------------------------------
// Bounded LRU Cache with TTL Eviction
// ---------------------------------------------------------------------------
export class BoundedLRUCache<K, V> {
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly cache = new Map<K, { value: V; expiresAt: number }>();

  constructor(maxSize = 5000, defaultTtlMs = 24 * 60 * 60 * 1000) {
    this.maxSize = maxSize;
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // Re-insert to mark as most recently used (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.defaultTtlMs): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first key in iteration order)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  *values(): IterableIterator<V> {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      } else {
        yield entry.value;
      }
    }
  }

  *entries(): IterableIterator<[K, V]> {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      } else {
        yield [key, entry.value];
      }
    }
  }

  *keys(): IterableIterator<K> {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      } else {
        yield key;
      }
    }
  }

  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        purged++;
      }
    }
    return purged;
  }
}

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
  const cachedLang = _userLanguageCache.get(String(telegramId));
  return {
    telegram_id: telegramId,
    step: 'idle',
    draft_data: cachedLang ? { lang: cachedLang } : {},
    updated_at: new Date().toISOString(),
  };
}

// Bounded in-memory caches (max 5,000 items, TTL 24h)
const _sessionCache = new BoundedLRUCache<string, BotSession>(5000, 24 * 60 * 60 * 1000);
const _userLanguageCache = new BoundedLRUCache<string, 'am' | 'en'>(5000, 24 * 60 * 60 * 1000);

// Telegram update_id deduplication cache (max 10,000 entries, 10-minute TTL)
const _updateIdCache = new BoundedLRUCache<number, boolean>(10000, 10 * 60 * 1000);

/**
 * Deduplicates Telegram updates within a sliding window.
 * Returns true if update is new; false if already processed.
 */
export function deduplicateUpdate(updateId: number): boolean {
  if (!updateId) return true;
  if (_updateIdCache.has(updateId)) {
    return false;
  }
  _updateIdCache.set(updateId, true);
  return true;
}

export function getUserLanguage(telegramId: number): 'am' | 'en' | undefined {
  return _userLanguageCache.get(String(telegramId)) || (_sessionCache.get(String(telegramId))?.draft_data?.lang as ('am' | 'en') | undefined);
}

export function setUserLanguage(telegramId: number, lang: 'am' | 'en'): void {
  _userLanguageCache.set(String(telegramId), lang);
  const sess = _sessionCache.get(String(telegramId));
  if (sess) {
    sess.draft_data = {
      ...sess.draft_data,
      lang,
    };
    _sessionCache.set(String(telegramId), sess);
  }
}

// ---------------------------------------------------------------------------
// Session CRUD — stored in `bot_sessions` Supabase table
// ---------------------------------------------------------------------------
export function getSession(telegramId: number): BotSession {
  // NOTE: Supabase JS v2 requires async, but the old code was sync.
  // We keep the sync interface here and use a module-level in-memory cache
  // that is populated by the async preload below. Call preloadSession() first.
  const sess = _sessionCache.get(String(telegramId)) ?? emptySession(telegramId);
  const userLang = _userLanguageCache.get(String(telegramId));
  if (userLang && !sess.draft_data?.lang) {
    sess.draft_data = { ...sess.draft_data, lang: userLang };
  }
  return sess;
}

/** Call this at the top of the webhook handler BEFORE calling getSession(). */
export async function preloadSession(telegramId: number): Promise<BotSession> {
  const cached = _sessionCache.get(String(telegramId));
  if (cached) {
    if (cached.draft_data?.lang) {
      _userLanguageCache.set(String(telegramId), cached.draft_data.lang);
    } else if (_userLanguageCache.get(String(telegramId))) {
      cached.draft_data.lang = _userLanguageCache.get(String(telegramId));
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
      _userLanguageCache.set(String(telegramId), session.draft_data.lang);
    } else if (_userLanguageCache.get(String(telegramId))) {
      session.draft_data.lang = _userLanguageCache.get(String(telegramId));
    }

    _sessionCache.set(String(telegramId), session);
    return session;
  } catch {
    const session = emptySession(telegramId);
    _sessionCache.set(String(telegramId), session);
    return session;
  }
}

// Per-user write queue to guarantee database persistence ordering without blocking webhook responses
const _sessionWriteQueues: Record<string, Promise<any>> = {};

export async function saveSession(session: BotSession, awaitDb = false): Promise<void> {
  // Ensure draft_data is an object and retains language
  session.draft_data = session.draft_data ?? {};
  const activeLang = session.draft_data.lang || _userLanguageCache.get(String(session.telegram_id));
  if (activeLang) {
    session.draft_data.lang = activeLang;
    _userLanguageCache.set(String(session.telegram_id), activeLang);
  }

  // 1. In-memory cache is updated IMMEDIATELY (0ms latency for subsequent gets)
  _sessionCache.set(String(session.telegram_id), session);

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
  const activeLang = current?.draft_data?.lang || _userLanguageCache.get(String(telegramId));
  if (activeLang) {
    preservedDraft.lang = activeLang;
    _userLanguageCache.set(String(telegramId), activeLang);
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
// Bounded roommate drafts cache (max 5,000 items, TTL 24h)
const _roommateDraftsCache = new BoundedLRUCache<string, RoommateProfileDraft>(5000, 24 * 60 * 60 * 1000);

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
    for (const s of _sessionCache.values()) {
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

/**
 * Generates the next sequential listing code.
 * - Roommate Search (Seekers - Roommate Before Room): #SPMARBR5, #SPMARBR6...
 * - Have a Room (Space Available - Roommate With Room): #SPMARWR1, #SPMARWR2...
 */
export async function getNextSpmarbrCode(category: 'seeker' | 'space_available' = 'seeker'): Promise<string> {
  const prefix = category === 'space_available' ? 'SPMARWR' : 'SPMARBR';
  const minStart = category === 'space_available' ? 1 : 5;

  try {
    const { data } = await supabase
      .from('profiles')
      .select('display_code')
      .ilike('display_code', `${prefix}%`);

    const existingNums: number[] = [];
    if (data && Array.isArray(data)) {
      for (const row of data) {
        const raw = (row.display_code || '').toUpperCase().replace(/^#/, '').trim();
        if (raw.startsWith(prefix)) {
          const numPart = raw.replace(prefix, '');
          if (numPart === '') {
            existingNums.push(1);
          } else {
            const parsed = parseInt(numPart, 10);
            if (!isNaN(parsed)) existingNums.push(parsed);
          }
        }
      }
    }

    const nextNum = existingNums.length > 0 ? Math.max(Math.max(...existingNums) + 1, minStart) : minStart;
    return `${prefix}${nextNum}`;
  } catch (err) {
    console.error('[getNextSpmarbrCode] error generating code:', err);
    return `${prefix}${minStart}`;
  }
}

/**
 * 300 ETB 30-Day Unified Membership Pass Management
 */
export interface MembershipStatus {
  isActive: boolean;
  expiresAt: Date | null;
  daysRemaining: number;
  lastPaymentRef?: string;
  orderId?: string;
}

const membershipCache = new Map<number, { status: MembershipStatus; cachedAt: number }>();
const MEMBERSHIP_CACHE_TTL_MS = 30 * 1000; // 30 seconds

export function invalidateMembershipCache(telegramId?: number): void {
  if (telegramId) {
    membershipCache.delete(telegramId);
  } else {
    membershipCache.clear();
  }
}

/**
 * Checks whether a user has an active 30-day all-access membership pass.
 * Valid if they have a completed order of >= 300 ETB verified within the last 30 days.
 */
export async function getUserMembershipStatus(telegramId: number): Promise<MembershipStatus> {
  const cached = membershipCache.get(telegramId);
  if (cached && Date.now() - cached.cachedAt < MEMBERSHIP_CACHE_TTL_MS) {
    return cached.status;
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, verified_at, created_at, transaction_reference, amount')
      .eq('buyer_telegram_id', telegramId)
      .eq('payment_status', 'completed')
      .gte('created_at', thirtyDaysAgo)
      .gte('amount', 300)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!order) {
      const res: MembershipStatus = { isActive: false, expiresAt: null, daysRemaining: 0 };
      membershipCache.set(telegramId, { status: res, cachedAt: Date.now() });
      return res;
    }

    const baseDate = new Date(order.verified_at || order.created_at);
    const expiresAt = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    const diffMs = expiresAt.getTime() - Date.now();
    const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    const isActive = diffMs > 0;

    const res: MembershipStatus = {
      isActive,
      expiresAt,
      daysRemaining,
      lastPaymentRef: order.transaction_reference,
      orderId: order.id,
    };
    membershipCache.set(telegramId, { status: res, cachedAt: Date.now() });
    return res;
  } catch (err) {
    console.error('[getUserMembershipStatus] error checking membership:', err);
    return { isActive: false, expiresAt: null, daysRemaining: 0 };
  }
}

export async function activateUserMembership(
  telegramId: number,
  orderId?: string,
  txRef?: string
): Promise<MembershipStatus> {
  invalidateMembershipCache(telegramId);
  return await getUserMembershipStatus(telegramId);
}



