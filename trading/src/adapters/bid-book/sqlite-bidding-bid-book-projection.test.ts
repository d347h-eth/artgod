import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STANDARD, COLLECTION_STATUS } from "@artgod/shared/types";
import { createPrometheusMetrics } from "@artgod/shared/observability/metrics";
import { createCollectionOfferSnapshotMetrics } from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import {
    BIDDING_BID_BOOK_PROJECTION_OUTCOME,
    BiddingBidBookProjectionScheduler,
    type BiddingBidBookProjectionOutcome,
} from "../../application/use-cases/bidding/bidding-bid-book-projection.js";
import { BIDDING_WORK_STAGE } from "../../application/use-cases/bidding/bidding-work-observability.js";
import { BiddingRuntimeMetrics } from "../observability/bidding-runtime-metrics.js";
import {
    BIDDING_RUNTIME_METRIC_LABEL,
    BIDDING_RUNTIME_METRIC_NAME,
    BIDDING_RUNTIME_METRIC_RESULT,
} from "../observability/bidding-runtime-metric-contract.js";
import { TRADING_METRICS_PREFIX } from "../../runtime/observability.js";
import { SqliteBiddingBidBookProjection } from "./sqlite-bidding-bid-book-projection.js";

// Projection tests target a fixture OpenSea slug instead of the preset market slug.
const BID_BOOK_PROJECTION_COLLECTION_SLUG = "bid-book-projection-fixture";
const BID_BOOK_PROJECTION_OPENSEA_SLUG = "bid-book-projection-fixture-opensea";
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
            slug: BID_BOOK_PROJECTION_COLLECTION_SLUG,
            address: COLLECTION_ADDRESS,
            standard: COLLECTION_STANDARD.Erc721,
            status: COLLECTION_STATUS.Live,
            tokenScopeKind:
                EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            openseaSlug: BID_BOOK_PROJECTION_OPENSEA_SLUG,
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

    it("keeps skipped writes unpublished but publishes a valid empty bid book", async () => {
        const missingSlug = "missing-projection-collection";
        const projection = new SqliteBiddingBidBookProjection(
            1,
            OWNER_ADDRESS,
            WETH_ADDRESS,
        );
        const metrics = await createPrometheusMetrics({
            prefix: TRADING_METRICS_PREFIX,
            collectProcessMetrics: false,
        });
        if (!metrics) throw new Error("prom-client is required for this test");
        const observability = new BiddingRuntimeMetrics(metrics);
        const outcomes: BiddingBidBookProjectionOutcome[] = [];
        let finishProjection!: () => void;
        const scheduler = new BiddingBidBookProjectionScheduler(
            projection,
            0,
            {
                onWorkStarted: (stage) => observability.onWorkStarted(stage),
                onProjectionRequested: (input) =>
                    observability.onProjectionRequested(input),
                onProjectionFinished: (input) => {
                    observability.onProjectionFinished(input);
                    outcomes.push(input.outcome);
                    finishProjection();
                },
                onProjectionStateChanged: (input) =>
                    observability.onProjectionStateChanged(input),
            },
            [missingSlug],
        );
        const snapshot = {
            collectionSlug: missingSlug,
            refreshedAt: 1234,
            offers: [],
            metrics: createCollectionOfferSnapshotMetrics(),
        };
        const publish = async () => {
            const finished = new Promise<void>((resolve) => {
                finishProjection = resolve;
            });
            scheduler.requestProjection(snapshot, "publication regression");
            await finished;
        };
        const metricValue = (scrape: string, name: string, label: string) =>
            Number(
                scrape
                    .split("\n")
                    .find(
                        (line) =>
                            line.startsWith(
                                `${TRADING_METRICS_PREFIX}${name}{`,
                            ) && line.includes(label),
                    )
                    ?.split(" ")
                    .at(-1),
            );
        const stageLabel = `${BIDDING_RUNTIME_METRIC_LABEL.Stage}="${BIDDING_WORK_STAGE.BidBookPublication}"`;

        try {
            await publish();
            assert.deepEqual(scheduler.readPublicationHealth(), {
                watchedCollections: 1,
                missingCollections: 1,
                laggingCollections: 1,
                oldestPublishedAtMs: null,
                oldestPublishedSnapshotAtMs: null,
            });
            assert.equal(
                db
                    .prepare(
                        "SELECT * FROM trading_bidding_collection_bid_book_state",
                    )
                    .all().length,
                0,
            );
            const skipped = await metrics.metricsText();
            assert.equal(
                metricValue(
                    skipped,
                    BIDDING_RUNTIME_METRIC_NAME.WorkLastSuccess,
                    stageLabel,
                ),
                0,
            );
            assert.ok(
                metricValue(
                    skipped,
                    BIDDING_RUNTIME_METRIC_NAME.WorkLastProgress,
                    stageLabel,
                ) > 0,
            );
            assert.equal(
                metricValue(
                    skipped,
                    `${BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionDuration}_count`,
                    `${BIDDING_RUNTIME_METRIC_LABEL.Result}="${BIDDING_BID_BOOK_PROJECTION_OUTCOME.Skipped}"`,
                ),
                1,
            );

            // The same empty snapshot becomes publishable once its local collection exists.
            db.prepare<[string, number]>(
                "UPDATE collections SET opensea_slug = ? WHERE collection_id = ?",
            ).run(missingSlug, collectionId);
            await publish();
            const health = scheduler.readPublicationHealth();
            assert.equal(health.missingCollections, 0);
            assert.equal(health.laggingCollections, 0);
            assert.ok((health.oldestPublishedAtMs ?? 0) > 0);
            assert.equal(
                health.oldestPublishedSnapshotAtMs,
                snapshot.refreshedAt,
            );
            const state = db
                .prepare<
                    [number]
                >("SELECT snapshot_refreshed_at_ms, row_count, last_error " + "FROM trading_bidding_collection_bid_book_state WHERE collection_id = ?")
                .get(collectionId);
            assert.deepEqual(state, {
                snapshot_refreshed_at_ms: snapshot.refreshedAt,
                row_count: 0,
                last_error: null,
            });
            const published = await metrics.metricsText();
            assert.ok(
                metricValue(
                    published,
                    BIDDING_RUNTIME_METRIC_NAME.WorkLastSuccess,
                    stageLabel,
                ) > 0,
            );
            assert.equal(
                metricValue(
                    published,
                    `${BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionDuration}_count`,
                    `${BIDDING_RUNTIME_METRIC_LABEL.Result}="${BIDDING_RUNTIME_METRIC_RESULT.Success}"`,
                ),
                1,
            );
            assert.deepEqual(outcomes, [
                BIDDING_BID_BOOK_PROJECTION_OUTCOME.Skipped,
                BIDDING_BID_BOOK_PROJECTION_OUTCOME.Published,
            ]);
        } finally {
            await scheduler.stop();
        }
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
                collectionSlug: BID_BOOK_PROJECTION_OPENSEA_SLUG,
                refreshedAt: 1234,
                offers: [
                    makeOpenSeaOffer({
                        orderHash: "collection-offer",
                        offerer: OTHER_ADDRESS,
                        priceWei: "832000000000000000",
                        nftItemType: 4,
                        identifierOrCriteria: "0",
                        criteria: {
                            collection: {
                                slug: BID_BOOK_PROJECTION_OPENSEA_SLUG,
                            },
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
                            collection: {
                                slug: BID_BOOK_PROJECTION_OPENSEA_SLUG,
                            },
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
                            collection: {
                                slug: BID_BOOK_PROJECTION_OPENSEA_SLUG,
                            },
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
                metrics: createCollectionOfferSnapshotMetrics({
                    offerCount: 4,
                }),
            },
            "test",
        );

        const rows = db
            .prepare<
                [number]
            >("SELECT order_id, scope_kind, scope_label, token_id, scope_traits_json, encoded_token_ids, maker, is_own, price_wei, quantity, valid_until, placed_at " + "FROM trading_bidding_bid_book_rows " + "WHERE collection_id = ? " + "ORDER BY order_id ASC")
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
                collectionSlug: BID_BOOK_PROJECTION_OPENSEA_SLUG,
                refreshedAt: 1234,
                offers: [
                    makeOpenSeaOffer({
                        orderHash: "collection-offer",
                        offerer: OTHER_ADDRESS,
                        priceWei: "832000000000000000",
                        nftItemType: 4,
                        identifierOrCriteria: "0",
                        criteria: {
                            collection: {
                                slug: BID_BOOK_PROJECTION_OPENSEA_SLUG,
                            },
                            contract: { address: COLLECTION_ADDRESS },
                            trait: null,
                            traits: null,
                            numeric_traits: null,
                            encoded_token_ids: "*",
                        },
                    }),
                ],
                metrics: createCollectionOfferSnapshotMetrics({
                    offerCount: 1,
                }),
            },
            "initial",
        );

        await projection.recordCollectionBidBookError({
            snapshot: {
                collectionSlug: BID_BOOK_PROJECTION_OPENSEA_SLUG,
                refreshedAt: 5678,
                offers: [],
                metrics: createCollectionOfferSnapshotMetrics(),
            },
            reason: "poll cadence",
            errorMessage: "projection failed",
            durationMs: 42,
        });

        const state = db
            .prepare<
                [number]
            >("SELECT snapshot_refreshed_at_ms, row_count, duration_ms, last_error " + "FROM trading_bidding_collection_bid_book_state " + "WHERE collection_id = ?")
            .get(collectionId) as ProjectionStateRow | undefined;

        assert.deepEqual(state, {
            snapshot_refreshed_at_ms: 5678,
            row_count: 1,
            duration_ms: 42,
            last_error: "projection failed",
        });
    });
});
