/**
 * Shared bounded LRU + single-flight request coalescing + stale-if-error memory cache
 * for Vercel serverless Lambdas. Never caches errors or negative auth/paywall states.
 */

export type CacheHitStatus = 'HIT' | 'STALE' | 'MISS';

export interface CacheFetchResult<T> {
  value: T;
  status: CacheHitStatus;
}

interface CacheEntry<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

export interface ResilientCacheOptions {
  maxEntries?: number;
  defaultTtlMs?: number;
  defaultStaleIfErrorMs?: number;
}

export interface GetOrFetchOptions<T> {
  ttlMs?: number;
  staleIfErrorMs?: number;
  shouldCache?: (value: T) => boolean;
}

export class ResilientMemoryCache<T> {
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly defaultStaleIfErrorMs: number;
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<CacheFetchResult<T>>>();

  constructor(options: ResilientCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 250);
    this.defaultTtlMs = Math.max(100, options.defaultTtlMs ?? 30_000);
    this.defaultStaleIfErrorMs = Math.max(0, options.defaultStaleIfErrorMs ?? 5 * 60_000);
  }

  getFresh(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = Date.now();
    if (now > entry.staleUntil) {
      this.entries.delete(key);
      return undefined;
    }
    if (now > entry.freshUntil) return undefined;
    // Refresh LRU order on read hit
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  getStale(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.staleUntil) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(
    key: string,
    value: T,
    ttlMs = this.defaultTtlMs,
    staleIfErrorMs = this.defaultStaleIfErrorMs
  ): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    const now = Date.now();
    this.entries.set(key, {
      value,
      freshUntil: now + ttlMs,
      staleUntil: now + ttlMs + staleIfErrorMs,
    });
  }

  async getOrFetchWithMeta(
    key: string,
    fetcher: () => Promise<T>,
    options: GetOrFetchOptions<T> = {}
  ): Promise<CacheFetchResult<T>> {
    const fresh = this.getFresh(key);
    if (fresh !== undefined) {
      return { value: fresh, status: 'HIT' };
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const staleIfErrorMs = options.staleIfErrorMs ?? this.defaultStaleIfErrorMs;

    const promise = (async (): Promise<CacheFetchResult<T>> => {
      try {
        const value = await fetcher();
        const allowCache = options.shouldCache ? options.shouldCache(value) : true;
        if (allowCache) {
          this.set(key, value, ttlMs, staleIfErrorMs);
        }
        return { value, status: 'MISS' };
      } catch (err) {
        const stale = this.getStale(key);
        if (stale !== undefined) {
          console.warn(`[cache] Serving stale snapshot for "${key}" after upstream error`);
          return { value: stale, status: 'STALE' };
        }
        throw err;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  async getOrFetch(
    key: string,
    fetcher: () => Promise<T>,
    options: GetOrFetchOptions<T> = {}
  ): Promise<T> {
    const res = await this.getOrFetchWithMeta(key, fetcher, options);
    return res.value;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
    this.inFlight.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(prefix)) this.inFlight.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

// Shared public feed & Matchmaker caches (centralized here for cycle-free invalidation)
export const spacesFeedCache = new ResilientMemoryCache<{
  spaces: Record<string, any>[];
}>({
  maxEntries: 200,
  defaultTtlMs: 30_000,
  defaultStaleIfErrorMs: 5 * 60_000,
});

export const roommatesFeedCache = new ResilientMemoryCache<{
  seekers: Record<string, any>[];
}>({
  maxEntries: 200,
  defaultTtlMs: 30_000,
  defaultStaleIfErrorMs: 5 * 60_000,
});

export const matchmakerPoolCache = new ResilientMemoryCache<any[]>({
  maxEntries: 10,
  defaultTtlMs: 30_000,
  defaultStaleIfErrorMs: 5 * 60_000,
});

export function invalidateSpacesFeedCache(): void {
  spacesFeedCache.clear();
}

export function invalidateRoommatesFeedCache(): void {
  roommatesFeedCache.clear();
}

export function invalidateMatchmakerPoolCache(): void {
  matchmakerPoolCache.clear();
}

export function invalidatePublicFeedsCache(): void {
  spacesFeedCache.clear();
  roommatesFeedCache.clear();
  matchmakerPoolCache.clear();
}
