import { afterEach, describe, expect, it, vi } from "vitest";
import {
    buildTokenPreviewDefaultQueryCacheKey,
    CachedGetTokenPreview,
    isTokenPreviewDefaultCacheEligible,
} from "./cached-get-token-preview.js";
import type {
    GetTokenPreviewInput,
    GetTokenPreviewOutput,
} from "./get-token-preview.js";
import { MemoryQueryCache } from "../../../infra/cache/memory.js";
import { QUERY_CACHE_NAMESPACES } from "../../../ports/query-cache.js";
import {
    COLLECTION_MEDIA_MODE_OPTIONS,
    COLLECTION_MEDIA_MODES,
    COLLECTION_MEDIA_PREFERENCE_VALUES,
} from "@artgod/shared/extensions";
import {
    getCurrentQueryCacheDebugInfo,
    QUERY_CACHE_DEBUG_STATUSES,
    runWithQueryCacheDebugContext,
} from "../../../utils/query-cache-debug.js";

// Extension-neutral variant fixtures exercise cache identity without Terraforms vocabulary.
const TEST_MEDIA_VARIANTS = {
    Preferred: "preferred",
    Alternate: "alternate",
    Current: "current",
} as const;

// Extension-neutral source fixture keeps the generic cache test out of extension domains.
const TEST_EXTENSION_MEDIA_MODE = "extension-mode";
const TEST_EXTENSION_MEDIA_OPTION = {
    key: TEST_EXTENSION_MEDIA_MODE,
    label: "extension",
};

describe("CachedGetTokenPreview", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("caches default media preview responses", () => {
        const cache = new MemoryQueryCache({ maxEntries: 8 });
        const output = createPreviewOutput();
        const inner = {
            getTokenPreview: vi.fn(() => output),
        };
        const cached = new CachedGetTokenPreview(cache, inner, {
            freshMs: 100,
            staleMs: 200,
            warmupConcurrency: 2,
        });

        runWithQueryCacheDebugContext(() => {
            expect(cached.getTokenPreview(createInput())).toBe(output);
            expect(getCurrentQueryCacheDebugInfo()).toEqual({
                status: QUERY_CACHE_DEBUG_STATUSES.Miss,
                ageMs: 0,
                ttlMs: 200,
            });
        });
        runWithQueryCacheDebugContext(() => {
            expect(cached.getTokenPreview(createInput())).toBe(output);
            expect(getCurrentQueryCacheDebugInfo().status).toBe(
                QUERY_CACHE_DEBUG_STATUSES.Hit,
            );
            expect(getCurrentQueryCacheDebugInfo().ttlMs).toBe(200);
        });

        expect(inner.getTokenPreview).toHaveBeenCalledTimes(1);
    });

    it("bypasses cache for non-default media responses", () => {
        const cache = new MemoryQueryCache({ maxEntries: 8 });
        const inner = {
            getTokenPreview: vi.fn(() =>
                createPreviewOutput({
                    media: {
                        selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
                        defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
                        availableModes: [
                            COLLECTION_MEDIA_MODE_OPTIONS.Snapshot,
                            TEST_EXTENSION_MEDIA_OPTION,
                        ],
                        preference: null,
                        selectedVariant: TEST_MEDIA_VARIANTS.Alternate,
                        defaultVariant: TEST_MEDIA_VARIANTS.Preferred,
                        availableVariants: [
                            {
                                key: TEST_MEDIA_VARIANTS.Preferred,
                                label: "preferred",
                            },
                            {
                                key: TEST_MEDIA_VARIANTS.Alternate,
                                label: "alternate",
                            },
                        ],
                    },
                }),
            ),
        };
        const cached = new CachedGetTokenPreview(cache, inner, {
            freshMs: 100,
            staleMs: 200,
            warmupConcurrency: 2,
        });

        runWithQueryCacheDebugContext(() => {
            cached.getTokenPreview(
                createInput({ mediaMode: COLLECTION_MEDIA_MODES.Snapshot }),
            );
            expect(getCurrentQueryCacheDebugInfo()).toEqual({
                status: QUERY_CACHE_DEBUG_STATUSES.Bypass,
                ageMs: null,
                ttlMs: null,
            });
        });
        runWithQueryCacheDebugContext(() => {
            cached.getTokenPreview(
                createInput({ mediaMode: COLLECTION_MEDIA_MODES.Snapshot }),
            );
            expect(getCurrentQueryCacheDebugInfo().status).toBe(
                QUERY_CACHE_DEBUG_STATUSES.Bypass,
            );
        });

        expect(inner.getTokenPreview).toHaveBeenCalledTimes(2);
    });

    it("bypasses stale entries whose response media does not match the request", () => {
        const cache = new MemoryQueryCache({ maxEntries: 8 });
        const liveInput = createInput({ mediaMode: TEST_EXTENSION_MEDIA_MODE });
        const liveKey = buildTokenPreviewDefaultQueryCacheKey(liveInput);
        cache.set(
            QUERY_CACHE_NAMESPACES.TokenPreviewDefault,
            liveKey,
            createPreviewOutput({
                media: {
                    selectedMode: TEST_EXTENSION_MEDIA_MODE,
                    defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
                    availableModes: [
                        COLLECTION_MEDIA_MODE_OPTIONS.Snapshot,
                        TEST_EXTENSION_MEDIA_OPTION,
                    ],
                    preference: null,
                    selectedVariant: TEST_MEDIA_VARIANTS.Current,
                    defaultVariant: TEST_MEDIA_VARIANTS.Current,
                    availableVariants: [
                        { key: TEST_MEDIA_VARIANTS.Current, label: "current" },
                    ],
                },
            }),
            200,
        );
        const output = createPreviewOutput({
            media: {
                selectedMode: TEST_EXTENSION_MEDIA_MODE,
                defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
                availableModes: [
                    COLLECTION_MEDIA_MODE_OPTIONS.Snapshot,
                    TEST_EXTENSION_MEDIA_OPTION,
                ],
                preference: null,
                selectedVariant: TEST_MEDIA_VARIANTS.Current,
                defaultVariant: TEST_MEDIA_VARIANTS.Current,
                availableVariants: [
                    { key: TEST_MEDIA_VARIANTS.Current, label: "current" },
                ],
            },
        });
        const inner = {
            getTokenPreview: vi.fn(() => output),
        };
        const cached = new CachedGetTokenPreview(cache, inner, {
            freshMs: 100,
            staleMs: 200,
            warmupConcurrency: 2,
        });

        runWithQueryCacheDebugContext(() => {
            expect(cached.getTokenPreview(liveInput)).toBe(output);
            expect(getCurrentQueryCacheDebugInfo()).toEqual({
                status: QUERY_CACHE_DEBUG_STATUSES.Bypass,
                ageMs: null,
                ttlMs: null,
            });
        });

        expect(inner.getTokenPreview).toHaveBeenCalledTimes(1);
        expect(
            cache.getEntry<GetTokenPreviewOutput>(
                QUERY_CACHE_NAMESPACES.TokenPreviewDefault,
                liveKey,
            ),
        ).toBeUndefined();
    });

    it("serves stale cache hits and refreshes them in the background", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const cache = new MemoryQueryCache({ maxEntries: 8 });
        const inner = {
            getTokenPreview: vi.fn(() => createPreviewOutput()),
        };
        const cached = new CachedGetTokenPreview(cache, inner, {
            freshMs: 100,
            staleMs: 200,
            warmupConcurrency: 2,
        });

        cached.getTokenPreview(createInput());
        vi.setSystemTime(new Date("2026-01-01T00:00:00.150Z"));

        runWithQueryCacheDebugContext(() => {
            expect(cached.getTokenPreview(createInput())).toEqual(
                createPreviewOutput(),
            );
            expect(getCurrentQueryCacheDebugInfo()).toEqual({
                status: QUERY_CACHE_DEBUG_STATUSES.Hit,
                ageMs: 150,
                ttlMs: 200,
            });
        });
        expect(inner.getTokenPreview).toHaveBeenCalledTimes(1);

        await vi.runAllTimersAsync();
        expect(inner.getTokenPreview).toHaveBeenCalledTimes(2);
    });

    it("reloads synchronously after the stale window expires", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const cache = new MemoryQueryCache({ maxEntries: 8 });
        const inner = {
            getTokenPreview: vi.fn(() => createPreviewOutput()),
        };
        const cached = new CachedGetTokenPreview(cache, inner, {
            freshMs: 100,
            staleMs: 200,
            warmupConcurrency: 2,
        });

        cached.getTokenPreview(createInput());
        vi.setSystemTime(new Date("2026-01-01T00:00:00.250Z"));

        runWithQueryCacheDebugContext(() => {
            expect(cached.getTokenPreview(createInput())).toEqual(
                createPreviewOutput(),
            );
            expect(getCurrentQueryCacheDebugInfo()).toEqual({
                status: QUERY_CACHE_DEBUG_STATUSES.Miss,
                ageMs: 0,
                ttlMs: 200,
            });
        });

        expect(inner.getTokenPreview).toHaveBeenCalledTimes(2);
    });

    it("warms only missing preview entries and skips fresh ones", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const cache = new MemoryQueryCache({ maxEntries: 8 });
        const inner = {
            getTokenPreview: vi.fn((input: GetTokenPreviewInput) =>
                createPreviewOutput({
                    token: {
                        tokenId: input.tokenRef,
                        image: `https://example.com/${input.tokenRef}.png`,
                        animationUrl: `https://example.com/${input.tokenRef}.html`,
                    },
                }),
            ),
        };
        const cached = new CachedGetTokenPreview(cache, inner, {
            freshMs: 100,
            staleMs: 200,
            warmupConcurrency: 2,
        });

        cached.getTokenPreview(
            createInput({
                tokenRef: "1",
                mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
            }),
        );
        cached.warmTokenPreviews({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            tokenRefs: ["1", "2", "2"],
            mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
        });

        await vi.runAllTimersAsync();
        expect(inner.getTokenPreview).toHaveBeenCalledTimes(2);
        expect(
            cache.getEntry<GetTokenPreviewOutput>(
                QUERY_CACHE_NAMESPACES.TokenPreviewDefault,
                buildTokenPreviewDefaultQueryCacheKey(
                    createInput({
                        tokenRef: "2",
                        mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
                    }),
                ),
            )?.value.token.tokenId,
        ).toBe("2");
    });
});

describe("token preview default query cache helpers", () => {
    it("normalizes refs and media mode in the cache key", () => {
        expect(
            buildTokenPreviewDefaultQueryCacheKey({
                chainRef: "Ethereum",
                collectionRef: "Terraforms",
                tokenRef: "7710",
                mediaMode: "Snapshot",
                mediaPreference: COLLECTION_MEDIA_PREFERENCE_VALUES.Enabled,
                mediaVariant: TEST_MEDIA_VARIANTS.Preferred.toUpperCase(),
            }),
        ).toBe(
            "chain=ethereum|collection=terraforms|token=7710|mode=snapshot|preference=enabled|variant=preferred",
        );
    });

    it("treats only default media responses as cacheable", () => {
        expect(isTokenPreviewDefaultCacheEligible(createPreviewOutput())).toBe(
            true,
        );
        expect(
            isTokenPreviewDefaultCacheEligible(
                createPreviewOutput({
                    media: {
                        selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
                        defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
                        availableModes: [
                            COLLECTION_MEDIA_MODE_OPTIONS.Snapshot,
                            TEST_EXTENSION_MEDIA_OPTION,
                        ],
                        preference: null,
                        selectedVariant: TEST_MEDIA_VARIANTS.Alternate,
                        defaultVariant: TEST_MEDIA_VARIANTS.Preferred,
                        availableVariants: [
                            {
                                key: TEST_MEDIA_VARIANTS.Preferred,
                                label: "preferred",
                            },
                            {
                                key: TEST_MEDIA_VARIANTS.Alternate,
                                label: "alternate",
                            },
                        ],
                    },
                }),
            ),
        ).toBe(false);
    });
});

function createInput(
    overrides: Partial<GetTokenPreviewInput> = {},
): GetTokenPreviewInput {
    return {
        chainRef: "ethereum",
        collectionRef: "terraforms",
        tokenRef: "7710",
        ...overrides,
    };
}

function createPreviewOutput(
    overrides: Partial<GetTokenPreviewOutput> = {},
): GetTokenPreviewOutput {
    return {
        media: {
            selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
            defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
            availableModes: [
                COLLECTION_MEDIA_MODE_OPTIONS.Snapshot,
                TEST_EXTENSION_MEDIA_OPTION,
            ],
            preference: null,
            selectedVariant: TEST_MEDIA_VARIANTS.Preferred,
            defaultVariant: TEST_MEDIA_VARIANTS.Preferred,
            availableVariants: [
                { key: TEST_MEDIA_VARIANTS.Preferred, label: "preferred" },
                { key: TEST_MEDIA_VARIANTS.Alternate, label: "alternate" },
            ],
        },
        token: {
            tokenId: "7710",
            image: "data:image/svg+xml;base64,terraforms-v2-image",
            animationUrl:
                "data:text/html;base64,PGh0bWw+PGJvZHk+dGVycmFmb3Jtcy12MjwvYm9keT48L2h0bWw+",
        },
        ...overrides,
    };
}
