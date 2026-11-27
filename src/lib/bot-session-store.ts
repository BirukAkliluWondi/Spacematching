import nodeCrypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { normalizeCanonicalTransactionRef } from './verify-et';
import {
  ResilientMemoryCache,
  invalidateMatchmakerPoolCache,
  invalidateRoommatesFeedCache,
  invalidateSpacesFeedCache,
} from './cache';

// ---------------------------------------------------------------------------
// Supabase client (service role — safe for server-side only)
// ---------------------------------------------------------------------------
const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseServiceRoleKey || 'missing-service-role-key'
);

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
  phone_number?: string;
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
  house_rules?: string;
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

// Bounded in-memory caches (max 5,000 items, TTL 15s to balance instant in-turn memory speed with multi-instance serverless freshness)
const _sessionCache = new BoundedLRUCache<string, BotSession>(5000, 15 * 1000);
const _userLanguageCache = new BoundedLRUCache<string, 'am' | 'en'>(5000, 24 * 60 * 60 * 1000);

// Telegram update_id deduplication cache (max 10,000 entries, 10-minute TTL)
const _updateIdCache = new BoundedLRUCache<number, boolean>(10000, 10 * 60 * 1000);

// In-flight action lock cache to prevent concurrent double-clicks and race conditions (TTL 5s)
const _actionLockCache = new BoundedLRUCache<string, boolean>(10000, 5 * 1000);

function hashLockKeyToNegativeId(lockKey: string): number {
  let h = 2166136261;
  for (let i = 0; i < lockKey.length; i++) {
    h ^= lockKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const unsigned = h >>> 0;
  return -(4000000000 + (unsigned % 900000000));
}

/**
 * Distributed-safe Telegram update deduplication across Vercel Lambdas.
 * Uses process LRU cache + atomic Postgres row insert on sentinel negative IDs.
 * Returns true if update is new; false if already processed.
 */
export async function deduplicateUpdate(updateId: number): Promise<boolean> {
  if (!updateId) return true;
  if (_updateIdCache.has(updateId)) {
    return false;
  }
  _updateIdCache.set(updateId, true);

  try {
    const sentinelId = -(3000000000 + (Math.abs(Math.floor(updateId)) % 900000000));
    const { error } = await supabase.from('bot_sessions').insert({
      telegram_id: String(sentinelId),
      step: 'dedup_update',
      draft_data: { update_id: updateId, ts: Date.now() },
      updated_at: new Date().toISOString(),
    });
    if (error && error.code === '23505') {
      // Check if it was the exact same update_id or a very old recycled slot (> 10 min)
      const { data: existing } = await supabase
        .from('bot_sessions')
        .select('draft_data')
        .eq('telegram_id', String(sentinelId))
        .maybeSingle();
      if (existing?.draft_data?.update_id === updateId) {
        return false;
      }
      if (!existing?.draft_data?.ts || Date.now() - Number(existing.draft_data.ts) > 10 * 60 * 1000) {
        await supabase.from('bot_sessions').upsert(
          {
            telegram_id: String(sentinelId),
            step: 'dedup_update',
            draft_data: { update_id: updateId, ts: Date.now() },
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'telegram_id' }
        );
      }
    }
  } catch {
    // Non-fatal: allow execution on transient DB error
  }
  return true;
}

/**
 * Acquires a distributed in-flight action lock via Postgres sentinel row + process LRU.
 * Prevents concurrent double-clicks or parallel payment verification across Vercel Lambdas.
 */
export async function acquireActionLock(lockKey: string, ttlMs = 5000): Promise<boolean> {
  if (!lockKey) return true;
  if (_actionLockCache.has(lockKey)) {
    return false;
  }
  _actionLockCache.set(lockKey, true, ttlMs);

  const sentinelId = String(hashLockKeyToNegativeId(lockKey));
  const now = Date.now();
  const expiresAt = now + ttlMs;

  try {
    const { error } = await supabase.from('bot_sessions').insert({
      telegram_id: sentinelId,
      step: 'action_lock',
      draft_data: { key: lockKey, expires_at: expiresAt },
      updated_at: new Date().toISOString(),
    });
    if (!error) {
      return true;
    }
    if (error.code === '23505') {
      const { data: existing } = await supabase
        .from('bot_sessions')
        .select('draft_data')
        .eq('telegram_id', sentinelId)
        .maybeSingle();
      const prevExp = Number(existing?.draft_data?.expires_at || 0);
      if (prevExp > now && existing?.draft_data?.key === lockKey) {
        _actionLockCache.set(lockKey, true, Math.max(500, prevExp - now));
        return false;
      }
      // Take over expired lock (or rare hash slot reuse) with compare-and-swap on updated/expires_at
      const { data: stolen } = await supabase
        .from('bot_sessions')
        .update({
          draft_data: { key: lockKey, expires_at: expiresAt },
          updated_at: new Date().toISOString(),
        })
        .eq('telegram_id', sentinelId)
        .filter('draft_data->>expires_at', 'eq', String(existing?.draft_data?.expires_at ?? prevExp))
        .select('telegram_id')
        .maybeSingle();
      if (!stolen) {
        return false;
      }
    }
  } catch (err) {
    console.warn(`[acquireActionLock] DB lock fallback (${lockKey}):`, err instanceof Error ? err.message : err);
  }
  return true;
}

/**
 * Releases an in-flight action lock early upon completion.
 */
export async function releaseActionLock(lockKey: string): Promise<void> {
  if (!lockKey) return;
  _actionLockCache.delete(lockKey);
  try {
    const sentinelId = String(hashLockKeyToNegativeId(lockKey));
    await supabase.from('bot_sessions').delete().eq('telegram_id', sentinelId);
  } catch {}
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
  const sess = _sessionCache.get(String(telegramId)) ?? emptySession(telegramId);
  const userLang = _userLanguageCache.get(String(telegramId));
  if (userLang && !sess.draft_data?.lang) {
    sess.draft_data = { ...sess.draft_data, lang: userLang };
  }
  return sess;
}

/** Always loads fresh session state from Supabase at the start of a request to prevent cross-Lambda staleness. */
export async function preloadSession(telegramId: number): Promise<BotSession> {
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

export async function saveSession(session: BotSession, _awaitDb = true): Promise<void> {
  // Ensure draft_data is an object and retains language
  session.draft_data = session.draft_data ?? {};
  const activeLang = session.draft_data.lang || _userLanguageCache.get(String(session.telegram_id));
  if (activeLang) {
    session.draft_data.lang = activeLang;
    _userLanguageCache.set(String(session.telegram_id), activeLang);
  }

  _sessionCache.set(String(session.telegram_id), session);

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

  // Always await persistence on serverless so Vercel does not freeze the Lambda early
  await next;
}

export async function clearSession(telegramId: number): Promise<void> {
  const current = getSession(telegramId);
  const preservedDraft: Record<string, any> = {};
  const activeLang = current?.draft_data?.lang || _userLanguageCache.get(String(telegramId));
  if (activeLang) {
    preservedDraft.lang = activeLang;
    _userLanguageCache.set(String(telegramId), activeLang);
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
const _allSpaceDraftsCache = new ResilientMemoryCache<Record<string, SpaceDraft>>({
  maxEntries: 5,
  defaultTtlMs: 30_000,
  defaultStaleIfErrorMs: 5 * 60_000,
});

export async function saveDraft(draft: SpaceDraft): Promise<void> {
  try {
    const { error } = await supabase
      .from('pending_space_drafts')
      .upsert({ ...draft, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) console.error('saveDraft error:', error.message);
  } catch (err) {
    console.error('saveDraft exception:', err);
  } finally {
    _allSpaceDraftsCache.clear();
    invalidateSpacesFeedCache();
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
    return await _allSpaceDraftsCache.getOrFetch('space_drafts:all', async () => {
      const { data, error } = await supabase.from('pending_space_drafts').select('*');
      if (error) throw new Error(error.message);
      if (!data) return {};
      return Object.fromEntries(data.map((d: SpaceDraft) => [d.id, d]));
    });
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

  if (cleanId) _roommateDraftsCache.set(cleanId.toLowerCase(), draft);
  if (cleanCode) _roommateDraftsCache.set(cleanCode.toLowerCase(), draft);
  if (draft.user_telegram_id) {
    _roommateDraftsCache.set(String(draft.user_telegram_id), draft);
  }

  // Persist into pending_roommate_drafts ONLY (never overwrite another user's live bot_sessions row)
  try {
    const serializedMeta = JSON.stringify({
      display_code: cleanCode,
      listing_category: draft.listing_category || (draft.space_rent ? 'space_available' : 'seeker'),
      space_type: draft.space_type,
      space_rent: draft.space_rent,
      space_share: draft.space_share,
      space_amenities: draft.space_amenities,
      space_photos: draft.space_photos,
      phone_number: draft.phone_number || draft.contact_phone,
      contact_phone: draft.contact_phone || draft.phone_number,
      channel_message_id: draft.channel_message_id,
      age: draft.age,
      job: draft.job,
      religion: draft.religion,
      house_rules: draft.house_rules,
      source_doc: draft.fayda_document_url && !draft.fayda_document_url.startsWith('{') ? draft.fayda_document_url : undefined,
    });

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
      fayda_document_url: serializedMeta,
      unlock_fee: Number(draft.unlock_fee || 100),
      status: draft.status || 'pending_approval',
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('pending_roommate_drafts')
      .upsert(validDbPayload, { onConflict: 'id' });
    if (error) console.warn('[saveRoommateDraft] DB upsert warning:', error.message);
  } catch (err) {
    console.warn('[saveRoommateDraft] DB exception:', err);
  } finally {
    _allRoommateDraftsCache.clear();
    invalidateRoommatesFeedCache();
    invalidateMatchmakerPoolCache();
  }
}

function hydrateDbDraft(dbDraft: any): RoommateProfileDraft | null {
  if (!dbDraft) return null;
  let parsedMeta: any = {};
  if (typeof dbDraft.fayda_document_url === 'string' && dbDraft.fayda_document_url.trim().startsWith('{')) {
    try {
      parsedMeta = JSON.parse(dbDraft.fayda_document_url);
    } catch {}
  }
  return {
    ...dbDraft,
    display_code: parsedMeta.display_code || dbDraft.display_code || dbDraft.id,
    listing_category: parsedMeta.listing_category || (parsedMeta.space_rent ? 'space_available' : 'seeker'),
    space_type: parsedMeta.space_type,
    space_rent: parsedMeta.space_rent ? Number(parsedMeta.space_rent) : undefined,
    space_share: parsedMeta.space_share ? Number(parsedMeta.space_share) : undefined,
    space_amenities: Array.isArray(parsedMeta.space_amenities) ? parsedMeta.space_amenities : undefined,
    space_photos: Array.isArray(parsedMeta.space_photos) ? parsedMeta.space_photos : undefined,
    phone_number: parsedMeta.phone_number || parsedMeta.contact_phone || dbDraft.phone_number,
    contact_phone: parsedMeta.contact_phone || parsedMeta.phone_number || dbDraft.contact_phone,
    channel_message_id: parsedMeta.channel_message_id || dbDraft.channel_message_id,
    age: parsedMeta.age || dbDraft.age,
    job: parsedMeta.job || dbDraft.job,
    religion: parsedMeta.religion || dbDraft.religion,
    house_rules: parsedMeta.house_rules || dbDraft.house_rules,
    unlock_fee: Number(dbDraft.unlock_fee || 100),
  };
}

export async function getRoommateDraft(draftId: string): Promise<RoommateProfileDraft | null> {
  const cleanId = (draftId || '').trim().toLowerCase();

  // 1. Try pending_roommate_drafts table (authoritative persistent status & metadata)
  let dbDraft: any = null;
  try {
    const { data } = await supabase
      .from('pending_roommate_drafts')
      .select('*')
      .ilike('id', draftId.trim())
      .maybeSingle();
    if (data) {
      dbDraft = hydrateDbDraft(data);
      _roommateDraftsCache.set(cleanId, dbDraft);
      return dbDraft;
    }
  } catch {}

  if (_roommateDraftsCache.has(cleanId)) {
    return _roommateDraftsCache.get(cleanId)!;
  }

  // 2. Active session fallback when draft not yet persisted in pending_roommate_drafts
  try {
    const last4 = cleanId.replace(/^rm/i, '');
    let match: any = null;

    for (const s of _sessionCache.values()) {
      const d = s.draft_data || {};
      const code = (d.display_code || '').toLowerCase();
      const tgStr = String(s.telegram_id || '');
      if (code === cleanId || code === `rm${last4}` || tgStr === cleanId) {
        match = s;
        break;
      }
    }

    if (!match) {
      const tgNum = Number(cleanId);
      if (!isNaN(tgNum) && tgNum !== 0) {
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
        id: d.display_code || draftId,
        display_code: d.display_code || draftId,
        user_telegram_id: Number(match.telegram_id),
        user_name: d.user_name || 'Verified Member',
        username: d.username || null,
        contact_phone: d.contact_phone || d.phone_number,
        phone_number: d.phone_number || d.contact_phone,
        age: d.age || 24,
        job: d.job,
        religion: d.religion,
        my_gender: d.gender || d.my_gender || 'Member',
        preferred_gender: d.preferred_gender || 'Any',
        preferred_subcity: d.preferred_subcity || [d.location || 'Addis Ababa'],
        budget_min: Number(d.space_share || d.budget_min || 0),
        budget_max: Number(d.space_rent || d.budget_max || 10000),
        lifestyle_bio: d.roommate_traits || d.lifestyle_bio || 'Roommate listing in Addis Ababa.',
        listing_category: d.listing_category || (d.space_rent ? 'space_available' : 'seeker'),
        space_type: d.space_type || 'Private Bedroom in Shared Flat',
        space_rent: d.space_rent ? Number(d.space_rent) : undefined,
        space_share: d.space_share ? Number(d.space_share) : undefined,
        space_amenities: d.space_amenities || [],
        space_photos: d.space_photos || [],
        unlock_fee: 100,
        fayda_status: 'verified',
        status: d.status || 'pending_approval',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      _roommateDraftsCache.set(cleanId, mergedDraft);
      return mergedDraft;
    }
  } catch (err) {
    console.warn('[getRoommateDraft] bot_sessions fallback error:', err);
  }

  return null;
}

const _allRoommateDraftsCache = new ResilientMemoryCache<Record<string, RoommateProfileDraft>>({
  maxEntries: 5,
  defaultTtlMs: 30_000,
  defaultStaleIfErrorMs: 5 * 60_000,
});

export async function getAllRoommateDrafts(): Promise<Record<string, RoommateProfileDraft>> {
  let baseDrafts: Record<string, RoommateProfileDraft> = {};
  try {
    baseDrafts = await _allRoommateDraftsCache.getOrFetch('roommate_drafts:all', async () => {
      const { data, error } = await supabase.from('pending_roommate_drafts').select('*');
      if (error) throw new Error(error.message);
      const map: Record<string, RoommateProfileDraft> = {};
      if (data && Array.isArray(data)) {
        data.forEach((d: any) => {
          const hydrated = hydrateDbDraft(d);
          if (hydrated) map[d.id] = hydrated;
        });
      }
      return map;
    });
  } catch {}

  const result: Record<string, RoommateProfileDraft> = { ...baseDrafts };

  // Merge in-memory drafts
  for (const [_k, v] of _roommateDraftsCache.entries()) {
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
const _managedChannelsCache = new ResilientMemoryCache<ManagedChannel[]>({
  maxEntries: 5,
  defaultTtlMs: 15 * 60 * 1000,
  defaultStaleIfErrorMs: 30 * 60 * 1000,
});

export async function getManagedChannels(): Promise<ManagedChannel[]> {
  return _managedChannelsCache.getOrFetch('managed_channels:all', async () => {
    const now = Date.now();
    try {
      const { data, error } = await supabase
        .from('bot_sessions')
        .select('draft_data')
        .eq('telegram_id', MANAGED_CHANNELS_SESSION_ID)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (data && data.draft_data && Array.isArray(data.draft_data.channels)) {
        cachedManagedChannels = data.draft_data.channels;
        managedChannelsCacheTime = now;
        return cachedManagedChannels!;
      }
    } catch (err) {
      if (cachedManagedChannels) {
        return cachedManagedChannels;
      }
      console.error('getManagedChannels error:', err);
      throw err;
    }

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
  }).catch(() => {
    if (cachedManagedChannels) return cachedManagedChannels;
    const defaultChannel = process.env.TELEGRAM_CHANNEL_ID || '@roommate_addis';
    return [
      {
        channel_id: defaultChannel,
        channel_title: 'SpaceMatch Addis Default',
        channel_username: defaultChannel.startsWith('@') ? defaultChannel : null,
        is_active: true,
        added_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
  });
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
    _managedChannelsCache.set('managed_channels:all', updated);

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
    _managedChannelsCache.set('managed_channels:all', updated);

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

// In-process sequence tracker to prevent collisions within the same instance
const _lastAllocatedSequence = { seeker: 0, space_available: 0 };

/**
 * Generates the next sequential listing code.
 * - Roommate Search (Seekers - Roommate Before Room): #SPMARBR5, #SPMARBR6...
 * - Have a Room (Space Available - Roommate With Room): #SPMARWR1, #SPMARWR2...
 * Coordinates across serverless instances via a dedicated bot_sessions sequence sentinel row.
 */
export async function getNextSpmarbrCode(category: 'seeker' | 'space_available' = 'seeker'): Promise<string> {
  const prefix = category === 'space_available' ? 'SPMARWR' : 'SPMARBR';
  const minStart = category === 'space_available' ? 1 : 5;
  const catKey = category === 'space_available' ? 'space_available' : 'seeker';
  const seqSentinelId = category === 'space_available' ? -5000002 : -5000001;

  try {
    const [{ data: profileCodes }, { data: draftIds }, { data: seqRow }] = await Promise.all([
      supabase
        .from('profiles')
        .select('display_code')
        .ilike('display_code', `%${prefix}%`)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('pending_roommate_drafts')
        .select('id')
        .ilike('id', `${prefix}%`)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('bot_sessions')
        .select('draft_data')
        .eq('telegram_id', seqSentinelId)
        .maybeSingle(),
    ]);

    let dbMax = Number(seqRow?.draft_data?.last_seq || 0);
    const scanCodes = [
      ...(profileCodes || []).map((r: any) => r.display_code),
      ...(draftIds || []).map((r: any) => r.id),
    ];
    for (const code of scanCodes) {
      const raw = String(code || '').toUpperCase().replace(/^#/, '').trim();
      if (raw.startsWith(prefix)) {
        const numPart = raw.replace(prefix, '');
        if (numPart === '') {
          dbMax = Math.max(dbMax, 1);
        } else {
          const parsed = parseInt(numPart, 10);
          if (!isNaN(parsed)) dbMax = Math.max(dbMax, parsed);
        }
      }
    }

    const currentMax = Math.max(dbMax, _lastAllocatedSequence[catKey], minStart - 1);
    const nextNum = currentMax + 1;
    _lastAllocatedSequence[catKey] = nextNum;

    try {
      await supabase.from('bot_sessions').upsert(
        {
          telegram_id: seqSentinelId,
          step: `seq_${catKey}`,
          draft_data: { last_seq: nextNum },
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'telegram_id' }
      );
    } catch {}

    return `${prefix}${nextNum}`;
  } catch (err) {
    console.error('[getNextSpmarbrCode] error generating code:', err);
    const fallbackMax = Math.max(_lastAllocatedSequence[catKey], minStart - 1);
    const fallbackNum = fallbackMax + 1;
    _lastAllocatedSequence[catKey] = fallbackNum;
    return `${prefix}${fallbackNum}`;
  }
}

/**
 * 100 ETB 3-Month (90-Day) Unified Membership Pass Management
 */
export interface MembershipStatus {
  isActive: boolean;
  expiresAt: Date | null;
  daysRemaining: number;
  lastPaymentRef?: string;
  orderId?: string;
}

const MEMBERSHIP_CACHE_TTL_MS = 60 * 1000; // 60s active-pass cache; unpaid/errors never cached
const _membershipCache = new ResilientMemoryCache<MembershipStatus>({
  maxEntries: 5000,
  defaultTtlMs: MEMBERSHIP_CACHE_TTL_MS,
  defaultStaleIfErrorMs: 0,
});

export function invalidateMembershipCache(telegramId?: number): void {
  if (telegramId) {
    _membershipCache.invalidate(String(telegramId));
  } else {
    _membershipCache.clear();
  }
}

/**
 * Checks whether a user has an active 3-month (90-day) all-access membership pass.
 * Valid if they have a completed order of >= 100 ETB verified/created within the last 90 days.
 */
export async function getUserMembershipStatus(telegramId: number): Promise<MembershipStatus> {
  return _membershipCache.getOrFetch(
    String(telegramId),
    async () => {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      try {
        const { data: order, error } = await supabase
          .from('orders')
          .select('id, verified_at, created_at, transaction_reference, amount')
          .or(`buyer_telegram_id.eq.${telegramId},renter_telegram_id.eq.${telegramId}`)
          .eq('payment_status', 'completed')
          .or(`verified_at.gte.${ninetyDaysAgo},created_at.gte.${ninetyDaysAgo}`)
          .gte('amount', 100)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) {
          console.error('[getUserMembershipStatus] Supabase query error (not caching):', error.message);
          return { isActive: false, expiresAt: null, daysRemaining: 0 };
        }

        if (!order) {
          return { isActive: false, expiresAt: null, daysRemaining: 0 };
        }

        const baseDate = new Date(order.verified_at || order.created_at);
        const expiresAt = new Date(baseDate.getTime() + 90 * 24 * 60 * 60 * 1000);
        const diffMs = expiresAt.getTime() - Date.now();
        const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
        const isActive = diffMs > 0;

        return {
          isActive,
          expiresAt,
          daysRemaining,
          lastPaymentRef: order.transaction_reference,
          orderId: order.id,
        };
      } catch (err) {
        console.error('[getUserMembershipStatus] error checking membership:', err);
        return { isActive: false, expiresAt: null, daysRemaining: 0 };
      }
    },
    { shouldCache: (res) => res.isActive === true }
  );
}

export async function activateUserMembership(
  telegramId: number,
  _orderId?: string,
  _txRef?: string
): Promise<MembershipStatus> {
  invalidateMembershipCache(telegramId);
  return await getUserMembershipStatus(telegramId);
}

const _adminIdsCache = new ResilientMemoryCache<number[]>({
  maxEntries: 5,
  defaultTtlMs: 60 * 1000,
  defaultStaleIfErrorMs: 10 * 60 * 1000,
});

export function invalidateAdminIdsCache(): void {
  _adminIdsCache.clear();
}

/**
 * Shared authoritative list of Admin Telegram IDs across webhook and admin web/API auth.
 * Strictly ignores unverified external channel creators (closes my_chat_member privilege escalation).
 */
export async function getAdminTelegramIds(): Promise<number[]> {
  const defaultAdminIds = [800701176, 980853835, 148318506]; // @birukadiyee & @WWEHID
  const envAdmins = (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !isNaN(n) && n > 0);

  return _adminIdsCache
    .getOrFetch('admin_ids:all', async () => {
      const adminSet = new Set<number>([...defaultAdminIds, ...envAdmins]);
      const usersRes = await supabase.from('users').select('telegram_id').eq('role', 'admin');
      if (usersRes?.error) {
        throw new Error(usersRes.error.message);
      }
      if (usersRes?.data) {
        for (const u of usersRes.data) {
          const id = Number(u.telegram_id);
          if (id > 0) adminSet.add(id);
        }
      }
      return Array.from(adminSet);
    })
    .catch((err) => {
      console.error('[getAdminTelegramIds] error:', err);
      return Array.from(new Set<number>([...defaultAdminIds, ...envAdmins]));
    });
}

// ---------------------------------------------------------------------------
// Payment Anti-Replay & Screenshot SHA-256 Fingerprint Helpers (Fail-Closed)
// ---------------------------------------------------------------------------

/**
 * Computes a volatile in-memory SHA-256 fingerprint of an uploaded receipt image buffer.
 * Zero raw image bytes are ever persisted (enforcing Invariant 1).
 */
export function computeReceiptImageSha256(imageBuffer: Buffer): string {
  return nodeCrypto.createHash('sha256').update(imageBuffer).digest('hex');
}

function escapePostgrestLike(val: string): string {
  return val.replace(/[%_\\,()]/g, '\\$&');
}

function receiptHashToSentinelId(sha256Hex: string): string {
  const numPart = parseInt(sha256Hex.slice(0, 10), 16);
  const safeNum = Number.isFinite(numPart) ? numPart : 0;
  return String(-(6000000000000 + safeNum));
}

/**
 * Checks if a transaction reference (raw code, URL, or canonical ID) has already
 * been redeemed by ANY user on a completed order.
 * Matches both bare canonical codes and legacy/URL forms (e.g. .../receipt/CODE or ?id=CODE).
 * Fails closed on database errors so replays can never slip past transient errors.
 */
export async function findRedeemedOrderByCanonicalRef(
  rawOrCanonRef: string
): Promise<{ redeemed: boolean; dbError?: boolean; orderId?: string; buyerTelegramId?: number; matchedRef?: string }> {
  const rawUpper = String(rawOrCanonRef || '').trim().toUpperCase();
  const canon = (normalizeCanonicalTransactionRef(rawOrCanonRef) || rawUpper).trim().toUpperCase();
  if (!canon) return { redeemed: false };

  const escapedCanon = escapePostgrestLike(canon);
  const filters: string[] = [`transaction_reference.ilike.${escapedCanon}`];

  // Match URL-stored forms safely without arbitrary short substring false positives
  if (canon.length >= 6 && /^[A-Z0-9_-]{6,32}$/.test(canon)) {
    filters.push(
      `transaction_reference.ilike.%/${escapedCanon}`,
      `transaction_reference.ilike.%=${escapedCanon}`,
      `transaction_reference.ilike.%/${escapedCanon}?%`,
      `transaction_reference.ilike.%=${escapedCanon}&%`
    );
  }
  if (rawUpper && rawUpper !== canon && !/[:/]/.test(rawUpper)) {
    filters.push(`transaction_reference.ilike.${escapePostgrestLike(rawUpper)}`);
  }

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('id, buyer_telegram_id, transaction_reference')
      .eq('payment_status', 'completed')
      .or(filters.join(','))
      .limit(1);

    if (error) {
      console.error('[anti-replay] orders lookup failed (failing closed):', error.message);
      return { redeemed: true, dbError: true };
    }

    if (data && data.length > 0) {
      return {
        redeemed: true,
        orderId: data[0].id,
        buyerTelegramId: Number(data[0].buyer_telegram_id || 0),
        matchedRef: data[0].transaction_reference,
      };
    }
    return { redeemed: false };
  } catch (err) {
    console.error('[anti-replay] orders lookup exception (failing closed):', err);
    return { redeemed: true, dbError: true };
  }
}

/**
 * Checks whether an uploaded receipt image's SHA-256 fingerprint was previously recorded
 * AFTER a successful verified payment completion. Failed verifications never lock a hash.
 */
export async function isReceiptHashRedeemed(
  sha256Hex: string
): Promise<{ redeemed: boolean; dbError?: boolean; ref?: string; payerTgId?: number }> {
  if (!sha256Hex || !/^[a-f0-9]{64}$/i.test(sha256Hex)) return { redeemed: false };
  const sentinelId = receiptHashToSentinelId(sha256Hex);
  try {
    const { data, error } = await supabase
      .from('bot_sessions')
      .select('step, draft_data')
      .eq('telegram_id', sentinelId)
      .limit(1);

    if (error) {
      console.error('[anti-replay] receipt hash lookup failed (failing closed):', error.message);
      return { redeemed: true, dbError: true };
    }
    if (!data || data.length === 0 || data[0].step !== 'redeemed_receipt_hash') {
      return { redeemed: false };
    }
    const meta = data[0].draft_data || {};
    const entry = meta.hashes?.[sha256Hex] || (meta.sha256 === sha256Hex ? meta : null);
    if (entry) {
      return {
        redeemed: true,
        ref: typeof entry.ref === 'string' ? entry.ref : undefined,
        payerTgId: typeof entry.payer_tg === 'number' ? entry.payer_tg : undefined,
      };
    }
    return { redeemed: false };
  } catch (err) {
    console.error('[anti-replay] receipt hash lookup exception (failing closed):', err);
    return { redeemed: true, dbError: true };
  }
}

/**
 * Records a receipt image SHA-256 fingerprint strictly AFTER Verify.ET succeeds and the
 * completed order has been committed to Postgres.
 */
export async function recordRedeemedReceiptHash(
  sha256Hex: string,
  canonicalRef: string,
  payerTelegramId: number
): Promise<void> {
  if (!sha256Hex || !/^[a-f0-9]{64}$/i.test(sha256Hex)) return;
  const sentinelId = receiptHashToSentinelId(sha256Hex);
  const nowIso = new Date().toISOString();
  try {
    const { data: existingRows } = await supabase
      .from('bot_sessions')
      .select('draft_data')
      .eq('telegram_id', sentinelId)
      .limit(1);

    const existingDraft = (existingRows && existingRows[0]?.draft_data) || {};
    const existingHashes =
      existingDraft.hashes && typeof existingDraft.hashes === 'object' ? existingDraft.hashes : {};

    await supabase.from('bot_sessions').upsert(
      {
        telegram_id: sentinelId,
        step: 'redeemed_receipt_hash',
        draft_data: {
          sha256: sha256Hex,
          ref: canonicalRef,
          payer_tg: payerTelegramId,
          redeemed_at: nowIso,
          hashes: {
            ...existingHashes,
            [sha256Hex]: {
              ref: canonicalRef,
              payer_tg: payerTelegramId,
              redeemed_at: nowIso,
            },
          },
        },
        updated_at: nowIso,
      },
      { onConflict: 'telegram_id' }
    );
  } catch (err) {
    console.warn('[anti-replay] Failed to persist redeemed receipt hash sentinel:', err);
  }
}




