import type {
    QueryCacheEntry,
    QueryCachePort,
} from "../../ports/query-cache.js";

export type MemoryQueryCacheOptions = {
    maxEntries: number;
};

export class MemoryQueryCache implements QueryCachePort {
    private readonly store = new Map<string, QueryCacheEntry<unknown>>();
    private readonly maxEntries: number;

    constructor(options: MemoryQueryCacheOptions) {
        this.maxEntries = Math.max(1, options.maxEntries);
    }

    get<T>(namespace: string, key: string): T | undefined {
        return this.getEntry<T>(namespace, key)?.value;
    }

    getEntry<T>(namespace: string, key: string): QueryCacheEntry<T> | undefined {
        const compositeKey = this.getCompositeKey(namespace, key);
        const entry = this.store.get(compositeKey);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.store.delete(compositeKey);
            return undefined;
        }
        return entry as QueryCacheEntry<T>;
    }

    set<T>(namespace: string, key: string, value: T, ttlMs: number): void {
        const normalizedTtlMs = Math.max(1, ttlMs);
        const storedAt = Date.now();
        const expiresAt = storedAt + normalizedTtlMs;
        this.store.set(this.getCompositeKey(namespace, key), {
            value,
            storedAt,
            expiresAt,
            ttlMs: normalizedTtlMs,
        });
        this.pruneExpiredEntries();
        this.pruneOverflowEntries();
    }

    delete(namespace: string, key: string): void {
        this.store.delete(this.getCompositeKey(namespace, key));
    }

    private pruneExpiredEntries(): void {
        const now = Date.now();
        for (const [key, entry] of this.store.entries()) {
            if (entry.expiresAt <= now) {
                this.store.delete(key);
            }
        }
    }

    private pruneOverflowEntries(): void {
        while (this.store.size > this.maxEntries) {
            const oldestKey = this.store.keys().next().value;
            if (!oldestKey) {
                break;
            }
            this.store.delete(oldestKey);
        }
    }

    private getCompositeKey(namespace: string, key: string): string {
        return `${namespace}:${key}`;
    }
}
