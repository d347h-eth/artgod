import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@artgod/shared/utils";
import {
    buildCollectionDetailDefaultQueryCacheKey,
    isCollectionDetailDefaultQueryCacheEligible,
    isPublicCollectionDetailCacheEligible,
    PublicCollectionDetailCache,
} from "./cached-get-collection-detail.js";
import type {
    GetCollectionDetailInput,
    GetCollectionDetailOutput,
} from "./get-collection-detail.js";
import {
    getCurrentQueryCacheDebugInfo,
    getCurrentQueryCacheDebugStatus,
    QUERY_CACHE_DEBUG_STATUSES,
    runWithQueryCacheDebugContext,
} from "../../../utils/query-cache-debug.js";

describe("PublicCollectionDetailCache", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("fills the public default page cache on the first eligible request", async () => {
        const output = createOutput();
        const inner = {
            getCollectionDetail: vi.fn(() => output),
        };
        const cached = new PublicCollectionDetailCache(
            inner,
            createDefaultMediaModePort(),
            null,
            {
                defaultInput: createInput(),
                refreshMs: 5000,
                previewWarmRefreshMs: 600000,
            },
        );

        await runWithQueryCacheDebugContext(async () => {
            expect(await cached.getCollectionDetail(createInput())).toBe(output);
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

    it("serves explicit default media mode requests from the same cached page", async () => {
        const output = createOutput();
        const inner = {
            getCollectionDetail: vi.fn(() => output),
        };
        const cached = new PublicCollectionDetailCache(
            inner,
            createDefaultMediaModePort(),
            null,
            {
                defaultInput: createInput(),
                refreshMs: 5000,
                previewWarmRefreshMs: 600000,
            },
        );

        await cached.getCollectionDetail(createInput());

        runWithQueryCacheDebugContext(() => {
            expect(
                cached.getCollectionDetail(
                    createInput({ mediaMode: output.media.defaultMode }),
                ),
            ).toBe(output);
            expect(getCurrentQueryCacheDebugStatus()).toBe(
                QUERY_CACHE_DEBUG_STATUSES.Hit,
            );
        });

        expect(inner.getCollectionDetail).toHaveBeenCalledTimes(1);
    });

    it("bypasses cache for non-default collection detail queries", () => {
        const inner = {
            getCollectionDetail: vi.fn(() => createOutput()),
        };
        const cached = new PublicCollectionDetailCache(
            inner,
            createDefaultMediaModePort(),
            null,
            {
                defaultInput: createInput(),
                refreshMs: 5000,
                previewWarmRefreshMs: 600000,
            },
        );

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

    it("refreshes the cached page on cadence and warms previews on the slower cadence", async () => {
        vi.useFakeTimers();

        const inner = {
            getCollectionDetail: vi.fn(() => createOutput()),
        };
        const warmup = {
            warmTokenPreviews: vi.fn(),
        };
        const cached = new PublicCollectionDetailCache(
            inner,
            createDefaultMediaModePort(),
            warmup,
            {
                defaultInput: createInput(),
                refreshMs: 1000,
                previewWarmRefreshMs: 3000,
            },
        );

        cached.start();
        await flushMicrotasks();

        expect(inner.getCollectionDetail).toHaveBeenCalledTimes(1);
        expect(warmup.warmTokenPreviews).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(inner.getCollectionDetail).toHaveBeenCalledTimes(2);
        expect(warmup.warmTokenPreviews).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(inner.getCollectionDetail).toHaveBeenCalledTimes(3);
        expect(warmup.warmTokenPreviews).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(inner.getCollectionDetail).toHaveBeenCalledTimes(4);
        expect(warmup.warmTokenPreviews).toHaveBeenCalledTimes(2);

        cached.stop();
    });

    it("keeps serving the last good cached page when a background refresh fails", async () => {
        vi.useFakeTimers();
        vi.spyOn(logger, "error").mockImplementation(() => undefined);

        const output = createOutput();
        const inner = {
            getCollectionDetail: vi
                .fn()
                .mockReturnValueOnce(output)
                .mockImplementation(() => {
                    throw new Error("boom");
                }),
        };
        const cached = new PublicCollectionDetailCache(
            inner,
            createDefaultMediaModePort(),
            null,
            {
                defaultInput: createInput(),
                refreshMs: 1000,
                previewWarmRefreshMs: 3000,
            },
        );

        cached.start();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(1000);

        runWithQueryCacheDebugContext(() => {
            expect(cached.getCollectionDetail(createInput())).toBe(output);
            expect(getCurrentQueryCacheDebugStatus()).toBe(
                QUERY_CACHE_DEBUG_STATUSES.Hit,
            );
        });
        expect(inner.getCollectionDetail).toHaveBeenCalledTimes(2);

        cached.stop();
    });
});

describe("collection detail default query cache helpers", () => {
    it("matches the default listed first-page query", () => {
        expect(isCollectionDetailDefaultQueryCacheEligible(createInput())).toBe(
            true,
        );
    });

    it("requires the configured public collection scope", () => {
        expect(
            isPublicCollectionDetailCacheEligible(
                createInput(),
                createInput({ collectionRef: "terraforms" }),
            ),
        ).toBe(false);
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
        collectionRef: "milady",
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
            slug: "milady",
            address: "0x1111111111111111111111111111111111111111",
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
            selectedMode: "artifact",
            defaultMode: "artifact",
            availableModes: [
                { key: "artifact", label: "artifact" },
                { key: "snapshot", label: "snapshot" },
            ],
        },
        tokens: {
            items: [
                {
                    tokenId: "1",
                    marketplaceBiddingSupported: true,
                    name: "Milady #1",
                    image: "https://example.com/1.png",
                    traitSummary: null,
                    listingPrice: "500000000000000000",
                    listingCurrency: "0x0000000000000000000000000000000000000000",
                    attributes: [],
                    hasMetadata: true,
                    metadataUpdatedAt: "2026-01-01T00:00:00.000Z",
                },
                {
                    tokenId: "2",
                    marketplaceBiddingSupported: true,
                    name: "Milady #2",
                    image: "https://example.com/2.png",
                    traitSummary: null,
                    listingPrice: "600000000000000000",
                    listingCurrency: "0x0000000000000000000000000000000000000000",
                    attributes: [],
                    hasMetadata: true,
                    metadataUpdatedAt: "2026-01-01T00:00:00.000Z",
                },
            ],
            prevCursor: null,
            nextCursor: null,
            limit: 250,
            totalItems: 2,
            rangeStart: 1,
            rangeEnd: 2,
            currentPage: 1,
            totalPages: 1,
        },
    };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function createDefaultMediaModePort(): {
    getDefaultMediaMode(): string;
} {
    return {
        getDefaultMediaMode: () => "artifact",
    };
}
