export const QUERY_CACHE_PROVIDERS = {
    Disabled: "disabled",
    Memory: "memory",
} as const;

export type QueryCacheProvider =
    (typeof QUERY_CACHE_PROVIDERS)[keyof typeof QUERY_CACHE_PROVIDERS];

export const QUERY_CACHE_NAMESPACES = {
    CollectionDetailDefault: "collection-detail-default",
} as const;

export type QueryCacheEntry<T> = {
    value: T;
    storedAt: number;
    expiresAt: number;
    ttlMs: number;
};

export interface QueryCachePort {
    get<T>(namespace: string, key: string): T | undefined;
    getEntry<T>(namespace: string, key: string): QueryCacheEntry<T> | undefined;
    set<T>(namespace: string, key: string, value: T, ttlMs: number): void;
    delete(namespace: string, key: string): void;
}
