import { describe, expect, it, vi } from "vitest";
import {
    buildCollectionDetailDefaultQueryCacheKey,
    CachedGetCollectionDetail,
    isCollectionDetailDefaultQueryCacheEligible,
} from "./cached-get-collection-detail.js";
import type {
    GetCollectionDetailInput,
    GetCollectionDetailOutput,
} from "./get-collection-detail.js";
import { MemoryQueryCache } from "../../../infra/cache/memory.js";
import {
    getCurrentQueryCacheDebugInfo,
    getCurrentQueryCacheDebugStatus,
    QUERY_CACHE_DEBUG_STATUSES,
    runWithQueryCacheDebugContext,
} from "../../../utils/query-cache-debug.js";

describe("CachedGetCollectionDetail", () => {
    it("caches eligible default collection detail responses", () => {
        const cache = new MemoryQueryCache({ maxEntries: 8 });
        const output = createOutput();
        const inner = {
            getCollectionDetail: vi.fn(() => output),
        };
        const cached = new CachedGetCollectionDetail(cache, inner, 5000);

        runWithQueryCacheDebugContext(() => {
            expect(cached.getCollectionDetail(createInput())).toBe(output);
            expect(getCurrentQueryCacheDebugStatus()).toBe(
                QUERY_CACHE_DEBUG_STATUSES.Miss,
            );
            expect(getCurrentQueryCacheDebugInfo()).toMatchObject({
                ageMs: 0,
                ttlMs: 5000,
            });
        });
        runWithQueryCacheDebugContext(() => {
            expect(cached.getCollectionDetail(createInput())).toBe(output);
            expect(getCurrentQueryCacheDebugStatus()).toBe(
                QUERY_CACHE_DEBUG_STATUSES.Hit,
            );
            expect(getCurrentQueryCacheDebugInfo().ttlMs).toBe(5000);
        });
        expect(inner.getCollectionDetail).toHaveBeenCalledTimes(1);
    });

    it("bypasses cache for non-default collection detail queries", () => {
        const cache = new MemoryQueryCache({ maxEntries: 8 });
        const inner = {
            getCollectionDetail: vi.fn(() => createOutput()),
        };
        const cached = new CachedGetCollectionDetail(cache, inner, 5000);

        runWithQueryCacheDebugContext(() => {
            cached.getCollectionDetail({
                ...createInput(),
                cursor: "opaque-cursor",
            });
            expect(getCurrentQueryCacheDebugInfo()).toEqual({
                status: QUERY_CACHE_DEBUG_STATUSES.Bypass,
                ageMs: null,
                ttlMs: null,
            });
        });
        runWithQueryCacheDebugContext(() => {
            cached.getCollectionDetail({
                ...createInput(),
                cursor: "opaque-cursor",
            });
            expect(getCurrentQueryCacheDebugInfo()).toEqual({
                status: QUERY_CACHE_DEBUG_STATUSES.Bypass,
                ageMs: null,
                ttlMs: null,
            });
        });

        expect(inner.getCollectionDetail).toHaveBeenCalledTimes(2);
    });

    it("does not cache thrown errors", () => {
        const cache = new MemoryQueryCache({ maxEntries: 8 });
        const inner = {
            getCollectionDetail: vi.fn(() => {
                throw new Error("boom");
            }),
        };
        const cached = new CachedGetCollectionDetail(cache, inner, 5000);

        expect(() => cached.getCollectionDetail(createInput())).toThrow("boom");
        expect(() => cached.getCollectionDetail(createInput())).toThrow("boom");
        expect(inner.getCollectionDetail).toHaveBeenCalledTimes(2);
    });
});

describe("collection detail default query cache helpers", () => {
    it("matches the default listed first-page query", () => {
        expect(isCollectionDetailDefaultQueryCacheEligible(createInput())).toBe(
            true,
        );
    });

    it("normalizes slug refs in the cache key", () => {
        expect(
            buildCollectionDetailDefaultQueryCacheKey({
                ...createInput(),
                chainRef: "Ethereum",
                collectionRef: "Terraforms",
            }),
        ).toBe(
            "chain=ethereum|collection=terraforms|status=listed|limit=250",
        );
    });
});

function createInput(
    overrides: Partial<GetCollectionDetailInput> = {},
): GetCollectionDetailInput {
    return {
        chainRef: "ethereum",
        collectionRef: "terraforms",
        tokenStatus: "listed",
        limit: 250,
        traits: [],
        traitRanges: [],
        ...overrides,
    };
}

function createOutput(): GetCollectionDetailOutput {
    return {
        chain: {
            id: 1,
            type: "evm",
            publicChainId: 1,
            slug: "ethereum",
            name: "Ethereum",
        },
        collection: {
            chainId: 1,
            collectionId: 1,
            slug: "terraforms",
            address: "0x4e1f41613c9084fdb9e34e11fae9412427480e56",
            standard: "erc721",
            status: "live",
            deploymentBlock: null,
            bootstrapAnchorBlock: null,
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z",
        },
        traits: {
            selected: [],
            selectedRanges: [],
            facets: [],
        },
        media: {
            selectedMode: "snapshot",
            defaultMode: "snapshot",
            availableModes: [{ key: "snapshot", label: "snapshot" }],
        },
        tokens: {
            items: [],
            prevCursor: null,
            nextCursor: null,
            limit: 250,
            totalItems: 0,
            rangeStart: 0,
            rangeEnd: 0,
            currentPage: 0,
            totalPages: 0,
        },
    };
}
