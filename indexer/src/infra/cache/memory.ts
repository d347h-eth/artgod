import type { Metrics } from "../../metrics/types.js";
import type { CachePort, CacheStats } from "../../ports/cache.js";

type CacheEntry = {
    value: unknown;
    expiresAt: number;
};

export type MemoryCacheOptions = {
    maxEntries: number;
    ttlMs: number;
    metrics?: Metrics;
};

export class InMemoryCache implements CachePort {
    private store = new Map<string, CacheEntry>();
    private hits = 0;
    private misses = 0;
    private readonly maxEntries: number;
    private readonly ttlMs: number;
    private readonly metrics?: Metrics;

    constructor(options: MemoryCacheOptions) {
        this.maxEntries = Math.max(1, options.maxEntries);
        this.ttlMs = Math.max(1, options.ttlMs);
        this.metrics = options.metrics;
    }

    get<T>(namespace: string, key: string): T | undefined {
        const fullKey = this.getKey(namespace, key);
        const entry = this.store.get(fullKey);
        if (!entry) {
            this.recordMiss(namespace);
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.store.delete(fullKey);
            this.recordMiss(namespace);
            return undefined;
        }
        this.recordHit(namespace);
        return entry.value as T;
    }

    set<T>(namespace: string, key: string, value: T, ttlMs?: number): void {
        const fullKey = this.getKey(namespace, key);
        const ttl = ttlMs ?? this.ttlMs;
        const expiresAt = Date.now() + Math.max(1, ttl);
        this.store.set(fullKey, { value, expiresAt });
        this.metrics?.increment("cache.set", 1, { namespace });
        this.prune();
        this.updateEntriesGauge();
    }

    delete(namespace: string, key: string): void {
        const fullKey = this.getKey(namespace, key);
        this.store.delete(fullKey);
        this.updateEntriesGauge();
    }

    stats(): CacheStats {
        return {
            hits: this.hits,
            misses: this.misses,
            entries: this.store.size,
        };
    }

    private prune(): void {
        if (this.store.size <= this.maxEntries) return;
        while (this.store.size > this.maxEntries) {
            const key = this.store.keys().next().value;
            if (!key) break;
            this.store.delete(key);
            this.metrics?.increment("cache.eviction", 1);
        }
    }

    private recordHit(namespace: string) {
        this.hits += 1;
        this.metrics?.increment("cache.hit", 1, { namespace });
    }

    private recordMiss(namespace: string) {
        this.misses += 1;
        this.metrics?.increment("cache.miss", 1, { namespace });
    }

    private updateEntriesGauge() {
        this.metrics?.gauge("cache.entries", this.store.size);
    }

    private getKey(namespace: string, key: string): string {
        return `${namespace}:${key}`;
    }
}
