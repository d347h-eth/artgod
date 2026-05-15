import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TRADING_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS,
} from "@artgod/shared/trading/runtime-state";
import {
    TRADING_BIDDING_BID_BOOK_SOURCE,
    TRADING_BIDDING_BID_SCOPE_KIND,
    TRADING_BOT_KIND,
    TRADING_BOT_RUNTIME_STATE,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
} from "@artgod/shared/types";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
} from "../../application/use-cases/trading/bidding-bid-book.js";
import { SqliteBiddingBidBookRepository } from "./sqlite-bidding-bid-book-repository.js";

const COLLECTION_ADDRESS = "0x1111111111111111111111111111111111111111";
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-bidding-bid-book-"));
    return join(dir, "main.sqlite");
}

function seedCollection(): number {
    const result = db
        .prepare<{
            chainId: number;
            slug: string;
            address: string;
            standard: string;
            status: string;
            tokenScopeKind: string;
            openseaSlug: string;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind, opensea_slug) " +
                "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind, @openseaSlug)",
        )
        .run({
            chainId: 1,
            slug: "terraforms",
            address: COLLECTION_ADDRESS,
            standard: "erc721",
            status: "live",
            tokenScopeKind: "contract_all_tokens",
            openseaSlug: "terraforms",
        });

    return Number(result.lastInsertRowid);
}

describe("SqliteBiddingBidBookRepository", () => {
    let collectionId = 0;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
        collectionId = seedCollection();
    });

    it("uses fresh bot projections and enriches own bid state without losing token applicability", () => {
        const repository = new SqliteBiddingBidBookRepository();
        seedBiddingRuntime(collectionId);
        insertProjectedState(collectionId, Date.now());
        insertProjectedBid({
            collectionId,
            orderId: "own-collection",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            scopeLabel: "collection",
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            priceWei: "200",
        });
        insertProjectedBid({
            collectionId,
            orderId: "opponent-collection",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            scopeLabel: "collection",
            maker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            priceWei: "210",
        });
        insertProjectedBid({
            collectionId,
            orderId: "token-5",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
            scopeLabel: "#5",
            tokenId: "5",
            priceWei: "300",
        });
        insertProjectedBid({
            collectionId,
            orderId: "token-set",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
            scopeLabel: "token set",
            encodedTokenIds: "1:10,20",
            priceWei: "250",
        });
        insertProjectedBid({
            collectionId,
            orderId: "token-set-all",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
            scopeLabel: "all tokens",
            encodedTokenIds: "*",
            priceWei: "260",
        });
        insertProjectedBid({
            collectionId,
            orderId: "token-set-empty",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
            scopeLabel: "empty token set",
            encodedTokenIds: "",
            priceWei: "255",
        });
        insertProjectedBid({
            collectionId,
            orderId: "token-set-invalid-range",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
            scopeLabel: "invalid token set",
            encodedTokenIds: "bad:10",
            priceWei: "254",
        });
        insertProjectedBid({
            collectionId,
            orderId: "token-set-malformed-tail",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
            scopeLabel: "malformed token set",
            encodedTokenIds: "4,bad,5",
            priceWei: "252",
        });
        insertProjectedBid({
            collectionId,
            orderId: "token-set-no-match",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
            scopeLabel: "nonmatching token set",
            encodedTokenIds: "99",
            priceWei: "253",
        });
        insertProjectedBid({
            collectionId,
            orderId: "trait-mode",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
            scopeLabel: "Mode=Terrain",
            scopeTraits: [{ type: "Mode", value: "Terrain" }],
            priceWei: "240",
        });
        insertProjectedBid({
            collectionId,
            orderId: "unknown",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Unknown,
            scopeLabel: "unknown",
            priceWei: "999",
        });

        const collectionBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });
        const ownBid = collectionBook.bids.find(
            (bid) => bid.orderId === "own-collection",
        );

        assert.equal(collectionBook.state.source, TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot);
        assert.equal(collectionBook.ownMakerAddress, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert.deepEqual(ownBid?.ownStatus, {
            position: "losing",
            constraints: ["ceiling"],
            job: {
                jobId: "collection-job",
                revision: 1,
                status: TRADING_JOB_STATUS.Enabled,
            },
        });

        const tokenBook = repository.listTokenBidBook({
            chainId: 1,
            collectionId,
            tokenId: "5",
            tokenTraits: [{ type: "Mode", value: "Terrain" }],
        });

        assert.deepEqual(
            tokenBook.bids.map((bid) => bid.orderId),
            [
                "token-5",
                "token-set-all",
                "token-set",
                "trait-mode",
                "opponent-collection",
                "own-collection",
            ],
        );
    });

    it("falls back to indexed orders when enabled bot projections are stale", () => {
        const repository = new SqliteBiddingBidBookRepository();
        seedBiddingRuntime(collectionId);
        const staleSnapshotMs =
            Date.now() - TRADING_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS - 1;
        insertProjectedState(collectionId, staleSnapshotMs);
        insertProjectedBid({
            collectionId,
            orderId: "stale-projection",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            scopeLabel: "collection",
            priceWei: "999000000000000000",
        });
        insertIndexedOrder({
            collectionId,
            id: "fresh-indexed-order",
            rawRestData: makeOpenSeaBuyOrderPayload({
                orderId: "fresh-indexed-order",
                maker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                priceWei: "100000000000000000",
                validFrom: 1,
                validUntil: 4_000_000_000,
            }),
            rawStreamData: null,
            updatedAt: "2026-05-15T02:00:00Z",
        });

        const bidBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });

        assert.equal(bidBook.state.source, TRADING_BIDDING_BID_BOOK_SOURCE.Orders);
        assert.deepEqual(
            bidBook.bids.map((bid) => bid.orderId),
            ["fresh-indexed-order"],
        );
    });

    it("applies exact AND trait-scope filtering and broad OR filtering", () => {
        const repository = new SqliteBiddingBidBookRepository();
        seedBiddingRuntime(collectionId);
        insertProjectedState(collectionId, Date.now());
        insertProjectedBid({
            collectionId,
            orderId: "mode-only",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
            scopeLabel: "Mode=Terrain",
            scopeTraits: [{ type: "Mode", value: "Terrain" }],
            priceWei: "100",
        });
        insertProjectedBid({
            collectionId,
            orderId: "mode-biome",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
            scopeLabel: "Biome=42 + Mode=Terrain",
            scopeTraits: [
                { type: "Biome", value: "42" },
                { type: "Mode", value: "Terrain" },
            ],
            priceWei: "200",
        });

        const andBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
            selectedTraits: [
                { key: "Mode", value: "Terrain" },
                { key: "Biome", value: "42" },
            ],
            selectedTraitRanges: [],
        });
        const orBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [
                { key: "Mode", value: "Terrain" },
                { key: "Biome", value: "42" },
            ],
            selectedTraitRanges: [],
        });

        assert.deepEqual(
            andBook.bids.map((bid) => bid.orderId),
            ["mode-biome"],
        );
        assert.deepEqual(
            orBook.bids.map((bid) => bid.orderId),
            ["mode-biome", "mode-only"],
        );
    });

    it("falls back to indexed orders and retries stream payloads when REST parsing returns no offer", () => {
        const repository = new SqliteBiddingBidBookRepository();
        db.prepare(
            "INSERT INTO trading_bot_runtime_state " +
                "(bot_kind, chain_id, wallet_id, address, state, heartbeat_at, started_at, updated_at, last_error) " +
                "VALUES (?, 1, 'wallet-1', ?, ?, ?, ?, ?, NULL)",
        ).run(
            TRADING_BOT_KIND.Bidding,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            TRADING_BOT_RUNTIME_STATE.Stopped,
            new Date().toISOString(),
            new Date().toISOString(),
            new Date().toISOString(),
        );
        insertIndexedOrder({
            collectionId,
            id: "stream-fallback",
            rawRestData: { order_hash: "stream-fallback" },
            rawStreamData: makeOpenSeaBuyOrderPayload({
                orderId: "stream-fallback",
                maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                priceWei: "100000000000000000",
                validFrom: 1,
                validUntil: 4_000_000_000,
            }),
            updatedAt: "2026-05-15T01:00:00Z",
        });

        const bidBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });

        assert.equal(bidBook.state.source, TRADING_BIDDING_BID_BOOK_SOURCE.Orders);
        assert.equal(bidBook.state.updatedAt, "2026-05-15T01:00:00Z");
        assert.deepEqual(
            bidBook.bids.map((bid) => ({
                orderId: bid.orderId,
                maker: bid.maker,
                isOwn: bid.isOwn,
                priceWei: bid.priceWei,
                placedAt: bid.placedAt,
            })),
            [
                {
                    orderId: "stream-fallback",
                    maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    isOwn: true,
                    priceWei: "100000000000000000",
                    placedAt: "1970-01-01T00:00:01Z",
                },
            ],
        );
    });
});

function seedBiddingRuntime(collectionId: number): void {
    db.prepare(
        "INSERT INTO trading_jobs " +
            "(job_id, bot_kind, chain_id, collection_id, status, target_kind, token_id, revision) " +
            "VALUES ('collection-job', ?, 1, ?, ?, ?, NULL, 1)",
    ).run(
        TRADING_BOT_KIND.Bidding,
        collectionId,
        TRADING_JOB_STATUS.Enabled,
        TRADING_JOB_TARGET_KIND.Collection,
    );
    db.prepare(
        "INSERT INTO trading_bidding_job_specs " +
            "(job_id, floor_wei, ceiling_wei, delta_wei, quantity, target_traits_json) " +
            "VALUES ('collection-job', '100', '200', '1', 1, '[]')",
    ).run();
    db.prepare(
        "INSERT INTO trading_bot_runtime_state " +
            "(bot_kind, chain_id, wallet_id, address, state, heartbeat_at, started_at, updated_at, last_error) " +
            "VALUES (?, 1, 'wallet-1', ?, ?, ?, ?, ?, NULL)",
    ).run(
        TRADING_BOT_KIND.Bidding,
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        TRADING_BOT_RUNTIME_STATE.Running,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
    );
}

function insertProjectedState(collectionId: number, snapshotRefreshedAtMs: number): void {
    db.prepare(
        "INSERT INTO trading_bidding_collection_bid_book_state " +
            "(chain_id, collection_id, source, snapshot_refreshed_at_ms, projected_at, row_count, duration_ms, last_error) " +
            "VALUES (1, ?, ?, ?, ?, 1, 1, NULL)",
    ).run(
        collectionId,
        TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
        snapshotRefreshedAtMs,
        new Date(snapshotRefreshedAtMs).toISOString(),
    );
}

function insertProjectedBid(input: {
    collectionId: number;
    orderId: string;
    scopeKind: string;
    scopeLabel: string;
    maker?: string;
    tokenId?: string | null;
    scopeTraits?: Array<{ type: string; value: string }>;
    encodedTokenIds?: string | null;
    priceWei: string;
}): void {
    db.prepare(
        "INSERT INTO trading_bidding_bid_book_rows " +
            "(chain_id, collection_id, order_id, source, scope_kind, scope_label, token_id, scope_traits_json, encoded_token_ids, maker, is_own, price_wei, quantity, currency_address, snapshot_refreshed_at_ms) " +
            "VALUES (1, @collectionId, @orderId, @source, @scopeKind, @scopeLabel, @tokenId, @scopeTraitsJson, @encodedTokenIds, @maker, 0, @priceWei, '1', @currencyAddress, @snapshotRefreshedAtMs)",
    ).run({
        collectionId: input.collectionId,
        orderId: input.orderId,
        source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
        scopeKind: input.scopeKind,
        scopeLabel: input.scopeLabel,
        tokenId: input.tokenId ?? null,
        scopeTraitsJson: JSON.stringify(input.scopeTraits ?? []),
        encodedTokenIds: input.encodedTokenIds ?? null,
        maker: input.maker ?? "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        priceWei: input.priceWei,
        currencyAddress: WETH_ADDRESS,
        snapshotRefreshedAtMs: Date.now(),
    });
}

function insertIndexedOrder(input: {
    collectionId: number;
    id: string;
    rawRestData: unknown;
    rawStreamData: unknown;
    updatedAt: string;
}): void {
    db.prepare(
        "INSERT INTO orders " +
            "(id, chain_id, collection_id, kind, side, source, maker, taker, contract_address, token_id, source_scope_kind, price, currency, valid_from, valid_until, fillability_status, source_status, raw_rest_data, raw_stream_data, created_at, updated_at) " +
            "VALUES (@id, 1, @collectionId, 'seaport', 'buy', 'opensea', '0x9999999999999999999999999999999999999999', NULL, @contractAddress, NULL, 'collection', '100000000000000000', @currency, 1, 4000000000, 'fillable', 'active', @rawRestData, @rawStreamData, @createdAt, @updatedAt)",
    ).run({
        id: input.id,
        collectionId: input.collectionId,
        contractAddress: COLLECTION_ADDRESS.toLowerCase(),
        currency: WETH_ADDRESS.toLowerCase(),
        rawRestData: JSON.stringify(input.rawRestData),
        rawStreamData: JSON.stringify(input.rawStreamData),
        createdAt: "2026-05-15T00:00:00Z",
        updatedAt: input.updatedAt,
    });
}

function makeOpenSeaBuyOrderPayload(input: {
    orderId: string;
    priceWei: string;
    maker: string;
    validFrom: number;
    validUntil: number;
}): unknown {
    return {
        order_hash: input.orderId,
        protocol_address: "0x0000000000000068f116a894984e2db1123eb395",
        maker: { address: input.maker },
        created_at: new Date(input.validFrom * 1000).toISOString(),
        expiration_time: input.validUntil,
        remaining_quantity: 1,
        protocol_data: {
            parameters: {
                offerer: input.maker,
                offer: [
                    {
                        itemType: 1,
                        token: WETH_ADDRESS,
                        identifierOrCriteria: "0",
                        startAmount: input.priceWei,
                        endAmount: input.priceWei,
                    },
                ],
                consideration: [
                    {
                        itemType: 4,
                        token: COLLECTION_ADDRESS,
                        identifierOrCriteria: "0",
                        startAmount: "1",
                        endAmount: "1",
                        recipient: input.maker,
                    },
                ],
                orderType: 3,
                startTime: String(input.validFrom),
                endTime: String(input.validUntil),
            },
        },
        criteria: {
            collection: { slug: "terraforms" },
            contract: { address: COLLECTION_ADDRESS },
            trait: null,
            traits: null,
            numeric_traits: null,
            encoded_token_ids: "*",
        },
    };
}
