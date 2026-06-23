import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SqliteBiddingBidBookProjection } from "./sqlite-bidding-bid-book-projection.js";

const COLLECTION_ADDRESS = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const OWNER_ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";

type ProjectedRow = {
    order_id: string;
    scope_kind: string;
    scope_label: string;
    token_id: string | null;
    scope_traits_json: string;
    encoded_token_ids: string | null;
    maker: string;
    is_own: number;
    price_wei: string;
    quantity: string;
    valid_until: number | null;
    placed_at: string | null;
};

type ProjectionStateRow = {
    snapshot_refreshed_at_ms: number | null;
    row_count: number;
    duration_ms: number | null;
    last_error: string | null;
};

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-bid-book-projection-"));
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
            slug: "terraforms-local",
            address: COLLECTION_ADDRESS,
            standard: "erc721",
            status: "live",
            tokenScopeKind: "contract_all_tokens",
            openseaSlug: "terraforms",
        });

    return Number(result.lastInsertRowid);
}

function makeOpenSeaOffer(params: {
    orderHash: string;
    offerer: string;
    priceWei: string;
    nftItemType: number;
    identifierOrCriteria: string;
    criteria: unknown;
    nftAmount?: string;
    orderType?: number;
    remainingQuantity?: number;
    createdDate?: string;
    closingDate?: string;
    startTime?: string;
}): unknown {
    return {
        order_hash: params.orderHash,
        chain: "ethereum",
        protocol_address: "0x0000000000000068f116a894984e2db1123eb395",
        expiration_time: params.closingDate ? undefined : 4_000_000_000,
        created_date: params.createdDate,
        closing_date: params.closingDate,
        remaining_quantity: params.remainingQuantity,
        protocol_data: {
            parameters: {
                offerer: params.offerer,
                offer: [
                    {
                        itemType: 1,
                        token: WETH_ADDRESS,
                        identifierOrCriteria: "0",
                        startAmount: params.priceWei,
                        endAmount: params.priceWei,
                    },
                ],
                consideration: [
                    {
                        itemType: params.nftItemType,
                        token: COLLECTION_ADDRESS,
                        identifierOrCriteria: params.identifierOrCriteria,
                        startAmount: params.nftAmount ?? "1",
                        endAmount: params.nftAmount ?? "1",
                        recipient: params.offerer,
                    },
                ],
                orderType: params.orderType ?? 0,
                startTime: params.startTime,
            },
        },
        criteria: params.criteria,
        price: {
            currency: "WETH",
            decimals: 18,
            value: params.priceWei,
        },
        status: "ACTIVE",
    };
}

describe("SqliteBiddingBidBookProjection", () => {
    let collectionId = 0;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
        collectionId = seedCollection();
    });

    it("classifies OpenSea REST collection, trait, and token offers into displayable bid-book scopes", async () => {
        const projection = new SqliteBiddingBidBookProjection(
            1,
            OWNER_ADDRESS,
            WETH_ADDRESS,
        );

        // Project the authoritative OpenSea snapshot rows into the UI bid-book table.
        await projection.replaceCollectionBidBook(
            {
                collectionSlug: "terraforms",
                refreshedAt: 1234,
                offers: [
                    makeOpenSeaOffer({
                        orderHash: "collection-offer",
                        offerer: OTHER_ADDRESS,
                        priceWei: "832000000000000000",
                        nftItemType: 4,
                        identifierOrCriteria: "0",
                        criteria: {
                            collection: { slug: "terraforms" },
                            contract: { address: COLLECTION_ADDRESS },
                            trait: null,
                            traits: null,
                            numeric_traits: null,
                            encoded_token_ids: "*",
                        },
                        startTime: "1800000000",
                    }),
                    makeOpenSeaOffer({
                        orderHash: "trait-offer",
                        offerer: OTHER_ADDRESS,
                        priceWei: "1500000000000000000",
                        nftItemType: 4,
                        identifierOrCriteria:
                            "90330390867309493013447701595835904434736540584155823248877877385678522520479",
                        criteria: {
                            collection: { slug: "terraforms" },
                            contract: { address: COLLECTION_ADDRESS },
                            trait: { type: "Chroma", value: "Plague" },
                            traits: [{ type: "Chroma", value: "Plague" }],
                            numeric_traits: null,
                            encoded_token_ids: "1239,4649",
                        },
                    }),
                    makeOpenSeaOffer({
                        orderHash: "token-offer",
                        offerer: OWNER_ADDRESS,
                        priceWei: "3000000000000000000",
                        nftItemType: 2,
                        identifierOrCriteria: "7958",
                        criteria: null,
                    }),
                    makeOpenSeaOffer({
                        orderHash: "numeric-trait-partial-offer",
                        offerer: OTHER_ADDRESS,
                        priceWei: "620000000000000000",
                        nftItemType: 4,
                        identifierOrCriteria:
                            "113703377976973476812273708665395356499261988770439230068849221413098206214838",
                        criteria: {
                            collection: { slug: "terraforms" },
                            contract: { address: COLLECTION_ADDRESS },
                            trait: null,
                            traits: null,
                            numeric_traits: [
                                { type: "Biome", min: 42, max: 42 },
                            ],
                            encoded_token_ids: "30,314,5108:5109",
                        },
                        nftAmount: "2",
                        orderType: 3,
                        remainingQuantity: 2,
                        createdDate: "2026-04-26T14:44:41.397Z",
                        closingDate: "2026-04-27T14:44:41.397Z",
                    }),
                ],
            },
            "test",
        );

        const rows = db
            .prepare<[number]>(
                "SELECT order_id, scope_kind, scope_label, token_id, scope_traits_json, encoded_token_ids, maker, is_own, price_wei, quantity, valid_until, placed_at " +
                    "FROM trading_bidding_bid_book_rows " +
                    "WHERE collection_id = ? " +
                    "ORDER BY order_id ASC",
            )
            .all(collectionId) as ProjectedRow[];
        const rowsById = new Map(rows.map((row) => [row.order_id, row]));

        assert.equal(rows.length, 4);
        assert.deepEqual(rowsById.get("collection-offer"), {
            order_id: "collection-offer",
            scope_kind: "collection",
            scope_label: "collection",
            token_id: null,
            scope_traits_json: "[]",
            encoded_token_ids: "*",
            maker: OTHER_ADDRESS.toLowerCase(),
            is_own: 0,
            price_wei: "832000000000000000",
            quantity: "1",
            valid_until: 4_000_000_000,
            placed_at: "2027-01-15T08:00:00Z",
        });
        assert.deepEqual(rowsById.get("trait-offer"), {
            order_id: "trait-offer",
            scope_kind: "trait",
            scope_label: "Chroma=Plague",
            token_id: null,
            scope_traits_json: JSON.stringify([
                { type: "Chroma", value: "Plague" },
            ]),
            encoded_token_ids: "1239,4649",
            maker: OTHER_ADDRESS.toLowerCase(),
            is_own: 0,
            price_wei: "1500000000000000000",
            quantity: "1",
            valid_until: 4_000_000_000,
            placed_at: null,
        });
        assert.deepEqual(rowsById.get("numeric-trait-partial-offer"), {
            order_id: "numeric-trait-partial-offer",
            scope_kind: "trait",
            scope_label: "Biome=42",
            token_id: null,
            scope_traits_json: JSON.stringify([{ type: "Biome", value: "42" }]),
            encoded_token_ids: "30,314,5108:5109",
            maker: OTHER_ADDRESS.toLowerCase(),
            is_own: 0,
            price_wei: "310000000000000000",
            quantity: "2",
            valid_until: 1_777_301_081,
            placed_at: "2026-04-26T14:44:41Z",
        });
        assert.deepEqual(rowsById.get("token-offer"), {
            order_id: "token-offer",
            scope_kind: "token",
            scope_label: "#7958",
            token_id: "7958",
            scope_traits_json: "[]",
            encoded_token_ids: null,
            maker: OWNER_ADDRESS.toLowerCase(),
            is_own: 1,
            price_wei: "3000000000000000000",
            quantity: "1",
            valid_until: 4_000_000_000,
            placed_at: null,
        });
    });

    it("records projection errors without clobbering the last successful row count", async () => {
        const projection = new SqliteBiddingBidBookProjection(
            1,
            OWNER_ADDRESS,
            WETH_ADDRESS,
        );

        await projection.replaceCollectionBidBook(
            {
                collectionSlug: "terraforms",
                refreshedAt: 1234,
                offers: [
                    makeOpenSeaOffer({
                        orderHash: "collection-offer",
                        offerer: OTHER_ADDRESS,
                        priceWei: "832000000000000000",
                        nftItemType: 4,
                        identifierOrCriteria: "0",
                        criteria: {
                            collection: { slug: "terraforms" },
                            contract: { address: COLLECTION_ADDRESS },
                            trait: null,
                            traits: null,
                            numeric_traits: null,
                            encoded_token_ids: "*",
                        },
                    }),
                ],
            },
            "initial",
        );

        await projection.recordCollectionBidBookError({
            snapshot: {
                collectionSlug: "terraforms",
                refreshedAt: 5678,
                offers: [],
            },
            reason: "poll cadence",
            errorMessage: "projection failed",
            durationMs: 42,
        });

        const state = db
            .prepare<[number]>(
                "SELECT snapshot_refreshed_at_ms, row_count, duration_ms, last_error " +
                    "FROM trading_bidding_collection_bid_book_state " +
                    "WHERE collection_id = ?",
            )
            .get(collectionId) as ProjectionStateRow | undefined;

        assert.deepEqual(state, {
            snapshot_refreshed_at_ms: 5678,
            row_count: 1,
            duration_ms: 42,
            last_error: "projection failed",
        });
    });
});
