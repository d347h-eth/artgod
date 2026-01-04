export type CacheStats = {
    hits: number;
    misses: number;
    entries: number;
};

export interface CachePort {
    get<T>(namespace: string, key: string): T | undefined;
    set<T>(namespace: string, key: string, value: T, ttlMs?: number): void;
    delete(namespace: string, key: string): void;
    stats(): CacheStats;
}
