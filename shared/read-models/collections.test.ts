import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "../database/db.js";
import {
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_SPAN_NAME,
} from "../observability/artgod-span-attributes.js";
import type { ApmPort, SpanAttributes } from "../observability/apm.js";
import { TOKEN_BROWSER_STATUS } from "../types/browse.js";
import { SqliteCollectionsReadModel } from "./collections.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const OWNER_A = "0x1111111111111111111111111111111111111111";
const OWNER_B = "0x2222222222222222222222222222222222222222";

class CapturingApm implements ApmPort {
    readonly spans: Array<{ name: string; attributes: SpanAttributes }> = [];

    async withSpan<T>(
        name: string,
        attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T> {
        this.spans.push({ name, attributes });
        return run();
    }

    withSyncSpan<T>(name: string, attributes: SpanAttributes, run: () => T): T {
        this.spans.push({ name, attributes });
        return run();
    }
}

describe("SqliteCollectionsReadModel observability", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-collections-read-"));
        setDbPath(join(tempDir, "test.sqlite"));
        createSchema();
    });

    afterEach(() => {
        setDbPath(join(tmpdir(), "artgod-collections-read-closed.sqlite"));
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("does not run a previous-page token query on first page", () => {
        insertToken("1", "100");
        insertToken("2", "200");
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.Listed,
            limit: 1,
        });

        expect(page.prevCursor).toBeNull();
        expect(page.nextCursor).toEqual(expect.any(String));
        expect(page.totalItems).toBe(2);
        expect(apm.spans.map((span) => span.name)).not.toContain(
            "backend.collection.db.tokens_prev_cursor",
        );
        expect(apm.spans.map((span) => span.name)).not.toContain(
            "backend.collection.db.tokens_count",
        );
        expect(apm.spans).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "backend.collection.db.tokens_page",
                    attributes: expect.objectContaining({
                        [ARTGOD_SPAN_ATTRIBUTE.CollectionTokenStatus]:
                            TOKEN_BROWSER_STATUS.Listed,
                        [ARTGOD_SPAN_ATTRIBUTE.CollectionCursorPresent]: false,
                    }),
                }),
            ]),
        );
    });

    it("hydrates listing prices after all-token page selection", () => {
        insertToken("1", "100");
        insertToken("2", "200");
        insertToken("10", "1000");
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.All,
            limit: 3,
        });

        expect(page.items.map((token) => token.tokenId)).toEqual([
            "1",
            "2",
            "10",
        ]);
        expect(page.items.map((token) => token.listingPrice)).toEqual([
            "100",
            "200",
            "1000",
        ]);
        expect(apm.spans).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "backend.collection.db.tokens_listing_hydration",
                    attributes: expect.objectContaining({
                        [ARTGOD_SPAN_ATTRIBUTE.CollectionTokenStatus]:
                            TOKEN_BROWSER_STATUS.All,
                        [ARTGOD_SPAN_ATTRIBUTE.TokensCount]: 3,
                    }),
                }),
            ]),
        );
    });

    it("hydrates token cards from normalized traits beyond metadata JSON", () => {
        insertToken("1", "100");
        insertTokenTrait("1", "Power", "9964");
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS]);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.All,
            limit: 1,
        });
        const cards = readModel.listCollectionTokenCardsByIds({
            chainId: 1,
            collectionId: 1,
            tokenIds: ["1"],
        });

        expect(page.items[0]?.attributes).toEqual([
            { key: "Power", value: "9964" },
        ]);
        expect(cards[0]?.attributes).toEqual([{ key: "Power", value: "9964" }]);
    });

    it("lists token rows without canonical metadata when normalized traits match", () => {
        insertBareToken("metadata-less-token");
        insertTokenTrait("metadata-less-token", "Power", "9964");
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS]);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.All,
            traitFilters: [{ key: "Power", value: "9964" }],
            limit: 1,
        });

        expect(page.items).toEqual([
            expect.objectContaining({
                tokenId: "metadata-less-token",
                name: null,
                image: null,
                attributes: [{ key: "Power", value: "9964" }],
            }),
        ]);
        expect(page.totalItems).toBe(1);
    });

    it("prefers cached token image paths for token card read models", () => {
        insertToken("1", "100");
        db.prepare(
            "UPDATE token_metadata SET image = ? WHERE chain_id = ? AND collection_id = ? AND token_id = ?",
        ).run("ipfs://source-image", 1, 1, "1");
        db.prepare(
            "INSERT INTO token_image_cache " +
                "(chain_id, collection_id, token_id, source_image_url, requested_max_dimension, cache_key, content_type, source_bytes, cached_bytes, relative_path, public_path) " +
                "VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
        ).run(
            1,
            1,
            "1",
            "ipfs://source-image",
            "cache-key",
            "image/webp",
            100,
            80,
            "1/1/1/cache.webp",
            "/media/token-images/1/1/1/cache.webp",
        );
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS]);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.All,
            limit: 1,
        });
        const preview = readModel.getCollectionTokenPreview({
            chainId: 1,
            collectionId: 1,
            tokenId: "1",
        });
        const cards = readModel.listCollectionTokenCardsByIds({
            chainId: 1,
            collectionId: 1,
            tokenIds: ["1"],
        });

        expect(page.items[0]?.image).toBe(
            "/media/token-images/1/1/1/cache.webp",
        );
        expect(preview.image).toBe("/media/token-images/1/1/1/cache.webp");
        expect(cards[0]?.image).toBe("/media/token-images/1/1/1/cache.webp");
    });

    it("resolves uncached IPFS media through the configured gateway", () => {
        insertToken("1003", "100");
        db.prepare(
            "UPDATE token_metadata SET image = ?, animation_url = ? WHERE chain_id = ? AND collection_id = ? AND token_id = ?",
        ).run(
            "ipfs://bafybeie7t5ehlwnhs5jh3r5pbqx7q2gvjpvzgm3zsftxxwrupzsaiemlpq/1003.png",
            "ipfs://bafybeie7t5ehlwnhs5jh3r5pbqx7q2gvjpvzgm3zsftxxwrupzsaiemlpq/1003.html",
            1,
            1,
            "1003",
        );
        const readModel = new SqliteCollectionsReadModel(
            [ZERO_ADDRESS],
            undefined,
            {
                ipfsGatewayOrigin: "https://gateway.example/ipfs",
            },
        );

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.All,
            limit: 1,
        });
        const detail = readModel.getCollectionTokenDetail({
            chainId: 1,
            collectionId: 1,
            tokenId: "1003",
        });
        const preview = readModel.getCollectionTokenPreview({
            chainId: 1,
            collectionId: 1,
            tokenId: "1003",
        });
        const cards = readModel.listCollectionTokenCardsByIds({
            chainId: 1,
            collectionId: 1,
            tokenIds: ["1003"],
        });

        const imageUrl =
            "https://gateway.example/ipfs/bafybeie7t5ehlwnhs5jh3r5pbqx7q2gvjpvzgm3zsftxxwrupzsaiemlpq/1003.png";
        const animationUrl =
            "https://gateway.example/ipfs/bafybeie7t5ehlwnhs5jh3r5pbqx7q2gvjpvzgm3zsftxxwrupzsaiemlpq/1003.html";
        expect(page.items[0]?.image).toBe(imageUrl);
        expect(cards[0]?.image).toBe(imageUrl);
        expect(detail.image).toBe(imageUrl);
        expect(detail.animationUrl).toBe(animationUrl);
        expect(preview.image).toBe(imageUrl);
        expect(preview.animationUrl).toBe(animationUrl);
    });

    it("maps normalized token attributes onto token card and detail read models", () => {
        insertToken("1", "100");
        db.prepare(
            "UPDATE token_metadata SET attributes_json = ? WHERE chain_id = ? AND collection_id = ? AND token_id = ?",
        ).run(
            JSON.stringify([
                { traitType: "Mode", value: "RawOnly" },
                { traitType: "Rank", value: 1 },
            ]),
            1,
            1,
            "1",
        );
        insertTokenTrait("1", "Mode", "Terrain");
        insertTokenTrait("1", "Rank", "7");
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS]);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.All,
            limit: 1,
        });
        const detail = readModel.getCollectionTokenDetail({
            chainId: 1,
            collectionId: 1,
            tokenId: "1",
        });

        expect(page.items[0]?.attributes).toEqual([
            { key: "Mode", value: "Terrain" },
            { key: "Rank", value: "7" },
        ]);
        expect(detail.attributes).toEqual([
            {
                key: "Mode",
                value: "Terrain",
                tokenCount: null,
                rarityPercent: null,
            },
            {
                key: "Rank",
                value: "7",
                tokenCount: null,
                rarityPercent: null,
            },
        ]);
    });

    it("short-circuits listed-token trait filters when no tokens match", () => {
        insertToken("1", "100");
        insertToken("2", "200");
        insertTokenTrait("1", "Hat", "Beanie");
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.Listed,
            traitFilters: [{ key: "Mode", value: "Terrain" }],
            limit: 250,
        });

        expect(page.items).toEqual([]);
        expect(page.totalItems).toBe(0);
        expect(page.rangeStart).toBe(0);
        expect(apm.spans.map((span) => span.name)).toContain(
            ARTGOD_SPAN_NAME.CollectionTraitFilterTokenCandidates,
        );
        expect(apm.spans.map((span) => span.name)).not.toContain(
            "backend.collection.db.tokens_page",
        );
        expect(apm.spans.map((span) => span.name)).not.toContain(
            "backend.collection.db.tokens_count",
        );
    });

    it("uses exact trait candidates for listed-token pagination", () => {
        insertToken("1", "300");
        insertToken("2", "100");
        insertToken("3", "200");
        insertToken("4", "150");
        insertTokenTrait("1", "Hat", "Beanie");
        insertTokenTrait("1", "Mode", "Terrain");
        insertTokenTrait("2", "Hat", "Cap");
        insertTokenTrait("2", "Mode", "Terrain");
        insertTokenTrait("3", "Hat", "Beanie");
        insertTokenTrait("3", "Mode", "Space");
        insertTokenTrait("4", "Hat", "Beanie");
        insertTokenTrait("4", "Mode", "Terrain");
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.Listed,
            traitFilters: [
                { key: "Hat", value: "Beanie" },
                { key: "Mode", value: "Terrain" },
            ],
            limit: 250,
        });

        expect(page.items.map((token) => token.tokenId)).toEqual(["4", "1"]);
        expect(page.items.map((token) => token.listingPrice)).toEqual([
            "150",
            "300",
        ]);
        expect(page.totalItems).toBe(2);
        expect(apm.spans.map((span) => span.name)).toContain(
            ARTGOD_SPAN_NAME.CollectionTraitFilterTokenCandidates,
        );
        expect(apm.spans.map((span) => span.name)).not.toContain(
            "backend.collection.db.tokens_count",
        );
        expect(apm.spans).toContainEqual(
            expect.objectContaining({
                name: "backend.collection.db.tokens_page",
                attributes: expect.objectContaining({
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionCandidateTokenIdsCount]: 2,
                }),
            }),
        );
    });

    it("uses exact trait candidates for all-token pagination", () => {
        insertToken("1", "300");
        insertToken("2", "100");
        insertToken("3", "200");
        insertTokenTrait("1", "Mode", "Terrain");
        insertTokenTrait("2", "Mode", "Space");
        insertTokenTrait("3", "Mode", "Terrain");
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.All,
            traitFilters: [{ key: "Mode", value: "Terrain" }],
            limit: 250,
        });

        expect(page.items.map((token) => token.tokenId)).toEqual(["1", "3"]);
        expect(page.totalItems).toBe(2);
        expect(apm.spans).toContainEqual(
            expect.objectContaining({
                name: "backend.collection.db.tokens_page",
                attributes: expect.objectContaining({
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionCandidateTokenIdsCount]: 2,
                }),
            }),
        );
    });

    it("uses exact trait candidates for listed-then-unlisted pagination", () => {
        insertToken("1", "300");
        insertToken("2", "100");
        insertToken("3", "200");
        insertTokenTrait("1", "Mode", "Terrain");
        insertTokenTrait("2", "Mode", "Space");
        insertTokenTrait("3", "Mode", "Terrain");
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.ListedThenUnlisted,
            traitFilters: [{ key: "Mode", value: "Terrain" }],
            limit: 250,
        });

        expect(page.items.map((token) => token.tokenId)).toEqual(["3", "1"]);
        expect(page.totalItems).toBe(2);
        expect(apm.spans).toContainEqual(
            expect.objectContaining({
                name: "backend.collection.db.tokens_page",
                attributes: expect.objectContaining({
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionCandidateTokenIdsCount]: 2,
                }),
            }),
        );
    });

    it("uses owner candidates for all-token pagination", () => {
        insertToken("1", "100");
        insertToken("2", "200");
        insertToken("3", "300");
        insertBalance("1", OWNER_A);
        insertBalance("2", OWNER_B);
        insertBalance("3", OWNER_A);
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.All,
            owner: OWNER_A,
            limit: 250,
        });

        expect(page.items.map((token) => token.tokenId)).toEqual(["1", "3"]);
        expect(page.totalItems).toBe(2);
        expect(apm.spans.map((span) => span.name)).toContain(
            ARTGOD_SPAN_NAME.CollectionOwnerTokenCandidates,
        );
        expect(apm.spans).toContainEqual(
            expect.objectContaining({
                name: "backend.collection.db.tokens_page",
                attributes: expect.objectContaining({
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionCandidateTokenIdsCount]: 2,
                }),
            }),
        );
    });

    it("intersects owner and trait candidates for token pagination", () => {
        insertToken("1", "300");
        insertToken("2", "100");
        insertToken("3", "200");
        insertTokenTrait("1", "Mode", "Terrain");
        insertTokenTrait("2", "Mode", "Terrain");
        insertTokenTrait("3", "Mode", "Space");
        insertBalance("1", OWNER_A);
        insertBalance("2", OWNER_B);
        insertBalance("3", OWNER_A);
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.ListedThenUnlisted,
            traitFilters: [{ key: "Mode", value: "Terrain" }],
            owner: OWNER_A,
            limit: 250,
        });

        expect(page.items.map((token) => token.tokenId)).toEqual(["1"]);
        expect(page.totalItems).toBe(1);
        const spanNames = apm.spans.map((span) => span.name);
        expect(spanNames).toContain(
            ARTGOD_SPAN_NAME.CollectionOwnerTokenCandidates,
        );
        expect(spanNames).toContain(
            ARTGOD_SPAN_NAME.CollectionTraitFilterTokenCandidates,
        );
        expect(
            spanNames.indexOf(ARTGOD_SPAN_NAME.CollectionOwnerTokenCandidates),
        ).toBeLessThan(
            spanNames.indexOf(
                ARTGOD_SPAN_NAME.CollectionTraitFilterTokenCandidates,
            ),
        );
        expect(apm.spans).toContainEqual(
            expect.objectContaining({
                name: "backend.collection.db.tokens_page",
                attributes: expect.objectContaining({
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionCandidateTokenIdsCount]: 1,
                }),
            }),
        );
    });

    it("short-circuits owner-filtered traits when the owner has no tokens", () => {
        insertToken("1", "100");
        insertTokenTrait("1", "Mode", "Terrain");
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.All,
            traitFilters: [{ key: "Mode", value: "Terrain" }],
            owner: OWNER_A,
            limit: 250,
        });

        expect(page.items).toEqual([]);
        expect(page.totalItems).toBe(0);
        expect(apm.spans.map((span) => span.name)).toContain(
            ARTGOD_SPAN_NAME.CollectionOwnerTokenCandidates,
        );
        expect(apm.spans.map((span) => span.name)).not.toContain(
            ARTGOD_SPAN_NAME.CollectionTraitFilterTokenCandidates,
        );
        expect(apm.spans.map((span) => span.name)).not.toContain(
            "backend.collection.db.tokens_page",
        );
    });

    it("hydrates explicit token-card listings without changing caller order", () => {
        insertToken("1", "100");
        insertToken("2", "200");
        insertToken("3", "1");
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS]);

        const cards = readModel.listCollectionTokenCardsByIds({
            chainId: 1,
            collectionId: 1,
            tokenIds: ["2", "1"],
            includeListings: true,
        });

        expect(cards.map((token) => token.tokenId)).toEqual(["2", "1"]);
        expect(cards.map((token) => token.listingPrice)).toEqual([
            "200",
            "100",
        ]);
    });

    it("uses owner candidates for owner-scoped trait facets", () => {
        insertToken("1", "100");
        insertToken("2", "200");
        insertToken("3", "300");
        insertTokenTrait("1", "Hat", "Beanie");
        insertTokenTrait("1", "Mode", "Terrain");
        insertTokenTrait("1", "Rank", "5");
        insertTokenTrait("2", "Mode", "Space");
        insertTokenTrait("2", "Rank", "100");
        insertTokenTrait("3", "Hat", "Cap");
        insertTokenTrait("3", "Mode", "Terrain");
        insertTokenTrait("3", "Rank", "9");
        insertBalance("1", OWNER_A);
        insertBalance("2", OWNER_B);
        insertBalance("3", OWNER_A);
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const facets = readModel.listCollectionTraitFacets(1, 1, OWNER_A, {
            rangeOnlyKeys: ["Rank"],
        });

        expect(facets).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    key: "Hat",
                    values: [
                        { value: "Beanie", tokenCount: 1 },
                        { value: "Cap", tokenCount: 1 },
                    ],
                }),
                expect.objectContaining({
                    key: "Mode",
                    values: [{ value: "Terrain", tokenCount: 2 }],
                }),
                {
                    key: "Rank",
                    displayKind: "range",
                    minValue: "5",
                    maxValue: "9",
                    values: [],
                },
            ]),
        );
        expect(
            facets.find((facet) => facet.key === "Mode")?.values,
        ).not.toContainEqual({ value: "Space", tokenCount: 1 });
        expect(apm.spans.map((span) => span.name)).toContain(
            ARTGOD_SPAN_NAME.CollectionOwnerTokenCandidates,
        );
        expect(apm.spans).toContainEqual(
            expect.objectContaining({
                name: "backend.collection.db.trait_facets",
                attributes: expect.objectContaining({
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionCandidateTokenIdsCount]: 2,
                }),
            }),
        );
    });

    it("returns range-only trait facets without high-cardinality values", () => {
        insertTraitStat("Hat", "Beanie", 2);
        insertTraitStat("???", "123456789", 1);
        insertTraitStat("???", "42", 1);
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const facets = readModel.listCollectionTraitFacets(1, 1, undefined, {
            rangeOnlyKeys: ["???"],
        });

        expect(facets).toEqual([
            expect.objectContaining({
                key: "Hat",
                values: [{ value: "Beanie", tokenCount: 2 }],
            }),
            {
                key: "???",
                displayKind: "range",
                minValue: "42",
                maxValue: "123456789",
                values: [],
            },
        ]);
        expect(apm.spans).toEqual(
            expect.arrayContaining([
                {
                    name: "backend.collection.db.trait_facets",
                    attributes: {
                        [ARTGOD_SPAN_ATTRIBUTE.ChainId]: 1,
                        [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: 1,
                        [ARTGOD_SPAN_ATTRIBUTE.CollectionOwnerPresent]: false,
                        [ARTGOD_SPAN_ATTRIBUTE.CollectionExcludeKeysCount]: 1,
                        [ARTGOD_SPAN_ATTRIBUTE.CollectionRangeOnlyKeysCount]: 1,
                    },
                },
                {
                    name: "backend.collection.db.trait_range_facets",
                    attributes: {
                        [ARTGOD_SPAN_ATTRIBUTE.ChainId]: 1,
                        [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: 1,
                        [ARTGOD_SPAN_ATTRIBUTE.CollectionOwnerPresent]: false,
                        [ARTGOD_SPAN_ATTRIBUTE.CollectionRangeOnlyKeysCount]: 1,
                    },
                },
            ]),
        );
    });

    it("returns collection-wide trait catalog counts for requested keys", () => {
        insertTraitStat("Zone", "Holo", 2);
        insertTraitStat("Zone", "Dynacrypts", 1);
        insertTraitStat("Biome", "22", 3);
        insertTraitStat("Mode", "Terrain", 3);
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const facets = readModel.listCollectionTraitCatalog({
            chainId: 1,
            collectionId: 1,
            keys: ["Zone", "Biome", "Missing"],
        });

        expect(facets).toEqual([
            {
                key: "Biome",
                values: [{ value: "22", tokenCount: 3 }],
            },
            {
                key: "Missing",
                values: [],
            },
            {
                key: "Zone",
                values: [
                    { value: "Dynacrypts", tokenCount: 1 },
                    { value: "Holo", tokenCount: 2 },
                ],
            },
        ]);
        expect(apm.spans).toContainEqual(
            expect.objectContaining({
                name: "backend.collection.db.trait_catalog",
                attributes: expect.objectContaining({
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitCatalogKeysCount]: 3,
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitFiltersCount]: 0,
                }),
            }),
        );
    });

    it("returns scoped trait catalog counts through exact trait candidates", () => {
        insertToken("1", "100");
        insertToken("2", "200");
        insertToken("3", "300");
        insertTokenTrait("1", "Level", "14");
        insertTokenTrait("1", "Zone", "Holo");
        insertTokenTrait("1", "Biome", "22");
        insertTokenTrait("2", "Level", "14");
        insertTokenTrait("2", "Zone", "Dynacrypts");
        insertTokenTrait("2", "Biome", "22");
        insertTokenTrait("3", "Level", "13");
        insertTokenTrait("3", "Zone", "Holo");
        insertTokenTrait("3", "Biome", "23");
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const facets = readModel.listCollectionTraitCatalog({
            chainId: 1,
            collectionId: 1,
            keys: ["Zone", "Biome"],
            scopeTraitFilters: [{ key: "Level", value: "14" }],
        });

        expect(facets).toEqual([
            {
                key: "Biome",
                values: [{ value: "22", tokenCount: 2 }],
            },
            {
                key: "Zone",
                values: [
                    { value: "Dynacrypts", tokenCount: 1 },
                    { value: "Holo", tokenCount: 1 },
                ],
            },
        ]);
        expect(apm.spans.map((span) => span.name)).toContain(
            ARTGOD_SPAN_NAME.CollectionTraitFilterTokenCandidates,
        );
        expect(apm.spans).toContainEqual(
            expect.objectContaining({
                name: "backend.collection.db.trait_catalog",
                attributes: expect.objectContaining({
                    [ARTGOD_SPAN_ATTRIBUTE.CollectionCandidateTokenIdsCount]: 2,
                }),
            }),
        );
    });
});

function createSchema(): void {
    db.exec(`
        CREATE TABLE collections (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            slug TEXT NOT NULL,
            address TEXT NOT NULL,
            standard TEXT NOT NULL,
            status TEXT NOT NULL,
            token_scope_kind TEXT NOT NULL DEFAULT 'contract_all_tokens',
            scope_start_token_id TEXT,
            scope_total_supply INTEGER,
            deployment_block INTEGER,
            bootstrap_anchor_block INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (chain_id, collection_id)
        );
        CREATE TABLE collection_scope_tokens (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            PRIMARY KEY (chain_id, collection_id, token_id)
        );
        CREATE TABLE tokens (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            token_sort_bucket INTEGER GENERATED ALWAYS AS (
                CASE WHEN token_id <> '' AND token_id NOT GLOB '*[^0-9]*' THEN 0 ELSE 1 END
            ) VIRTUAL,
            token_sort_length INTEGER GENERATED ALWAYS AS (
                CASE WHEN token_id <> '' AND token_id NOT GLOB '*[^0-9]*'
                    THEN LENGTH(CASE WHEN LTRIM(token_id, '0') = '' THEN '0' ELSE LTRIM(token_id, '0') END)
                    ELSE 0
                END
            ) VIRTUAL,
            token_sort_value TEXT GENERATED ALWAYS AS (
                CASE WHEN token_id <> '' AND token_id NOT GLOB '*[^0-9]*'
                    THEN CASE WHEN LTRIM(token_id, '0') = '' THEN '0' ELSE LTRIM(token_id, '0') END
                    ELSE token_id
                END
            ) VIRTUAL,
            PRIMARY KEY (chain_id, collection_id, token_id)
        );
        CREATE INDEX tokens_collection_numeric_sort_idx
            ON tokens (chain_id, collection_id, token_sort_bucket, token_sort_length, token_sort_value, token_id);
        CREATE TABLE token_metadata (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            name TEXT,
            image TEXT,
            animation_url TEXT,
            attributes_json TEXT,
            updated_at TEXT,
            PRIMARY KEY (chain_id, collection_id, token_id)
        );
        CREATE TABLE token_image_cache (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            source_image_url TEXT NOT NULL,
            requested_max_dimension INTEGER,
            cache_key TEXT NOT NULL,
            content_type TEXT NOT NULL,
            source_bytes INTEGER NOT NULL,
            cached_bytes INTEGER NOT NULL,
            width INTEGER,
            height INTEGER,
            relative_path TEXT NOT NULL,
            public_path TEXT NOT NULL,
            created_at TEXT,
            updated_at TEXT,
            PRIMARY KEY (chain_id, collection_id, token_id)
        );
        CREATE TABLE orders (
            id TEXT PRIMARY KEY,
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT,
            price TEXT,
            currency TEXT,
            source_scope_kind TEXT NOT NULL,
            side TEXT,
            source_status TEXT NOT NULL,
            fillability_status TEXT NOT NULL,
            valid_from INTEGER,
            valid_until INTEGER
        );
        CREATE TABLE attribute_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            key TEXT NOT NULL
        );
        CREATE TABLE attributes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            attribute_key_id INTEGER NOT NULL,
            value TEXT NOT NULL
        );
        CREATE TABLE collection_trait_stats (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            attribute_key_id INTEGER NOT NULL,
            attribute_id INTEGER NOT NULL,
            token_count INTEGER NOT NULL
        );
        CREATE TABLE token_attributes (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            attribute_id INTEGER NOT NULL
        );
        CREATE TABLE nft_balances (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            owner TEXT NOT NULL,
            amount TEXT NOT NULL
        );
    `);
}

function insertToken(tokenId: string, price: string): void {
    db.prepare(
        "INSERT INTO tokens (chain_id, collection_id, token_id) VALUES (?, ?, ?)",
    ).run(1, 1, tokenId);
    db.prepare(
        "INSERT INTO token_metadata (chain_id, collection_id, token_id, name, image, animation_url, attributes_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(1, 1, tokenId, `Token ${tokenId}`, null, null, "[]", "2026-01-01");
    db.prepare(
        "INSERT INTO orders (id, chain_id, collection_id, token_id, price, currency, source_scope_kind, side, source_status, fillability_status, valid_from, valid_until) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        `order-${tokenId}`,
        1,
        1,
        tokenId,
        price,
        ZERO_ADDRESS,
        "token",
        "sell",
        "active",
        "fillable",
        null,
        null,
    );
}

function insertBareToken(tokenId: string): void {
    db.prepare(
        "INSERT INTO tokens (chain_id, collection_id, token_id) VALUES (?, ?, ?)",
    ).run(1, 1, tokenId);
}

function insertBalance(tokenId: string, owner: string, amount = "1"): void {
    db.prepare(
        "INSERT INTO nft_balances (chain_id, collection_id, token_id, owner, amount) VALUES (?, ?, ?, ?, ?)",
    ).run(1, 1, tokenId, owner, amount);
}

function insertTokenTrait(tokenId: string, key: string, value: string): void {
    const keyId = getOrCreateAttributeKey(key);
    const attributeId = getOrCreateAttribute(keyId, value);
    db.prepare(
        "INSERT INTO token_attributes (chain_id, collection_id, token_id, attribute_id) VALUES (?, ?, ?, ?)",
    ).run(1, 1, tokenId, attributeId);
}

function getOrCreateAttributeKey(key: string): number {
    const row = db
        .prepare(
            "SELECT id FROM attribute_keys WHERE chain_id = ? AND collection_id = ? AND key = ?",
        )
        .get(1, 1, key) as { id: number } | undefined;
    if (row) {
        return row.id;
    }
    const result = db
        .prepare(
            "INSERT INTO attribute_keys (chain_id, collection_id, key) VALUES (?, ?, ?)",
        )
        .run(1, 1, key);
    return Number(result.lastInsertRowid);
}

function getOrCreateAttribute(attributeKeyId: number, value: string): number {
    const row = db
        .prepare(
            "SELECT id FROM attributes WHERE chain_id = ? AND collection_id = ? AND attribute_key_id = ? AND value = ?",
        )
        .get(1, 1, attributeKeyId, value) as { id: number } | undefined;
    if (row) {
        return row.id;
    }
    const result = db
        .prepare(
            "INSERT INTO attributes (chain_id, collection_id, attribute_key_id, value) VALUES (?, ?, ?, ?)",
        )
        .run(1, 1, attributeKeyId, value);
    return Number(result.lastInsertRowid);
}

function insertTraitStat(key: string, value: string, tokenCount: number): void {
    const keyResult = db
        .prepare(
            "INSERT INTO attribute_keys (chain_id, collection_id, key) VALUES (?, ?, ?)",
        )
        .run(1, 1, key);
    const attributeResult = db
        .prepare(
            "INSERT INTO attributes (chain_id, collection_id, attribute_key_id, value) VALUES (?, ?, ?, ?)",
        )
        .run(1, 1, keyResult.lastInsertRowid, value);
    db.prepare(
        "INSERT INTO collection_trait_stats (chain_id, collection_id, attribute_key_id, attribute_id, token_count) VALUES (?, ?, ?, ?, ?)",
    ).run(
        1,
        1,
        keyResult.lastInsertRowid,
        attributeResult.lastInsertRowid,
        tokenCount,
    );
}
