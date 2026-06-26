import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import type { ApmPort, SpanAttributes } from "@artgod/shared/observability/apm";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TRADING_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS,
} from "@artgod/shared/trading/runtime-state";
import { TOKEN_SET_SCHEMA_KIND } from "@artgod/shared/types/token-sets";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    TRADING_BIDDING_BID_BOOK_SOURCE,
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
    TRADING_BIDDING_BID_BOOK_PRICE_KIND,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
    TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
    TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
    TRADING_BIDDING_BID_SCOPE_KIND,
    TRADING_BOT_KIND,
    TRADING_BOT_RUNTIME_STATE,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
} from "@artgod/shared/types";
import {
    exactBidBookRowPrice,
    persistedBidBookRowEffectiveWei,
} from "../../application/use-cases/trading/bidding-bid-book.js";
import { BIDDING_SPAN_ATTRIBUTE } from "../../application/use-cases/trading/bidding-observability.js";
import { SqliteBiddingBidBookRepository } from "./sqlite-bidding-bid-book-repository.js";
import { SqliteBiddingJobsRepository } from "./sqlite-bidding-jobs-repository.js";

const COLLECTION_ADDRESS = "0x1111111111111111111111111111111111111111";
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const BIDDING_MAKER_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INDEXED_ORDER_PLACED_AT = "2026-05-15T00:00:00Z";

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

    it("records source selection, orders mapping, filtering, and enrichment spans", () => {
        const apm = new CapturingApm();
        const repository = new SqliteBiddingBidBookRepository(apm);
        insertIndexedOrder({
            collectionId,
            id: "fallback-order",
            rawRestData: makeOpenSeaBuyOrderPayload({
                orderId: "fallback-order",
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
            includeOwnJobContext: false,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });

        assert.deepEqual(
            bidBook.bids.map((bid) => bid.orderId),
            ["fallback-order"],
        );
        assert.ok(
            apm.spans.some(
                (span) =>
                    span.name ===
                    "backend.bidding.repository.source_enabled_jobs",
            ),
        );
        assert.ok(
            apm.spans.some(
                (span) =>
                    span.name === "backend.bidding.repository.orders_query",
            ),
        );
        assert.deepEqual(
            apm.spans.find(
                (span) => span.name === "backend.bidding.repository.orders_map",
            )?.attributes,
            {
                [BIDDING_SPAN_ATTRIBUTE.ChainId]: 1,
                [BIDDING_SPAN_ATTRIBUTE.CollectionId]: collectionId,
                [BIDDING_SPAN_ATTRIBUTE.Source]:
                    TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
                [BIDDING_SPAN_ATTRIBUTE.OrdersRowsCount]: 1,
                [BIDDING_SPAN_ATTRIBUTE.OrdersCollectionScopeRowsCount]:
                    1,
                [BIDDING_SPAN_ATTRIBUTE.OrdersAttributeScopeRowsCount]: 0,
                [BIDDING_SPAN_ATTRIBUTE.OrdersTokenScopeRowsCount]: 0,
                [BIDDING_SPAN_ATTRIBUTE.OrdersTokenSetScopeRowsCount]: 0,
                [BIDDING_SPAN_ATTRIBUTE.OrdersSeaportJsonRowsCount]: 0,
                [BIDDING_SPAN_ATTRIBUTE.OrdersValidUntilRowsCount]: 1,
            },
        );
        assert.equal(
            apm.spans.find(
                (span) =>
                    span.name ===
                    "backend.bidding.repository.collection_filter_sort",
            )?.attributes[BIDDING_SPAN_ATTRIBUTE.BidsCount],
            1,
        );
        assert.equal(
            apm.spans.find(
                (span) =>
                    span.name === "backend.bidding.repository.own_signals",
            )?.attributes[BIDDING_SPAN_ATTRIBUTE.JobsCount],
            0,
        );
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
            placedAt: "2026-05-16T00:00:00Z",
            validUntil: 1_800_000_000,
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
        seedJobRuntimeState({
            jobId: "collection-job",
            currentPriceWei: "200",
            activeOrderId: "own-collection",
            activeOrderPlacedAt: "2026-05-17T00:00:00Z",
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "210",
        });

        const collectionBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
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
        assert.equal(ownBid?.placedAt, "2026-05-17T00:00:00Z");
        assert.equal(ownBid?.validUntil, 1_900_000_000);
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
            includeOwnJobContext: true,
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

    it("suppresses stale own market rows for active job targets", () => {
        const repository = new SqliteBiddingBidBookRepository();
        seedBiddingRuntime(collectionId);
        insertProjectedState(collectionId, Date.now());
        insertProjectedBid({
            collectionId,
            orderId: "old-own-collection",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            scopeLabel: "collection",
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            priceWei: "220",
        });
        insertProjectedBid({
            collectionId,
            orderId: "opponent-collection",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            scopeLabel: "collection",
            maker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            priceWei: "210",
        });

        const queuedBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });

        assert.deepEqual(
            queuedBook.bids.map((bid) => bid.orderId),
            ["opponent-collection", "job-intent:collection-job"],
        );

        insertProjectedBid({
            collectionId,
            orderId: "new-own-collection",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            scopeLabel: "collection",
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            priceWei: "190",
        });
        seedJobRuntimeState({
            jobId: "collection-job",
            currentPriceWei: "190",
            activeOrderId: "new-own-collection",
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "210",
        });

        const activeBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });

        assert.deepEqual(
            activeBook.bids.map((bid) => bid.orderId),
            ["opponent-collection", "new-own-collection"],
        );
        assert.deepEqual(
            activeBook.bids.find((bid) => bid.orderId === "new-own-collection")
                ?.ownStatus,
            {
                position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
                constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
                job: {
                    jobId: "collection-job",
                    revision: 1,
                    status: TRADING_JOB_STATUS.Enabled,
                },
            },
        );
    });

    it("suppresses completed own cancellations in orders fallback after archive", () => {
        const repository = new SqliteBiddingBidBookRepository();
        seedBiddingRuntime(collectionId);
        db.prepare(
            "UPDATE trading_jobs SET status = @status, archived_at = @archivedAt WHERE job_id = @jobId",
        ).run({
            status: TRADING_JOB_STATUS.Archived,
            archivedAt: "2026-05-17T00:00:00Z",
            jobId: "collection-job",
        });
        insertIndexedOrder({
            collectionId,
            id: "cancelled-own-order",
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            updatedAt: "2026-05-17T00:00:01Z",
        });
        insertIndexedOrder({
            collectionId,
            id: "opponent-order",
            maker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            updatedAt: "2026-05-17T00:00:01Z",
        });
        insertCompletedOrderCancellation({
            collectionId,
            orderId: "cancelled-own-order",
        });

        const bidBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });

        assert.equal(bidBook.state.source, TRADING_BIDDING_BID_BOOK_SOURCE.Orders);
        assert.equal(bidBook.ownMakerAddress, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert.deepEqual(
            bidBook.bids.map((bid) => bid.orderId),
            ["opponent-order"],
        );
    });

    it("keeps failed own cancellations visible in orders fallback", () => {
        const repository = new SqliteBiddingBidBookRepository();
        seedBiddingRuntime(collectionId);
        db.prepare(
            "UPDATE trading_jobs SET status = @status WHERE job_id = @jobId",
        ).run({
            status: TRADING_JOB_STATUS.Archived,
            jobId: "collection-job",
        });
        insertIndexedOrder({
            collectionId,
            id: "failed-cancel-own-order",
            maker: BIDDING_MAKER_ADDRESS,
            updatedAt: "2026-05-17T00:00:01Z",
        });
        insertFailedOrderCancellation({
            collectionId,
            orderId: "failed-cancel-own-order",
        });

        const bidBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });

        assert.deepEqual(
            bidBook.bids.map((bid) => ({
                orderId: bid.orderId,
                maker: bid.maker,
                isOwn: bid.isOwn,
                materialization: bid.materialization,
                price: bid.price,
            })),
            [
                {
                    orderId: "failed-cancel-own-order",
                    maker: BIDDING_MAKER_ADDRESS,
                    isOwn: true,
                    materialization: {
                        kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
                        jobId: "collection-job",
                        status: TRADING_JOB_STATUS.Archived,
                        phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed,
                    },
                    price: exactBidBookRowPrice("100"),
                },
            ],
        );
    });

    it("keeps pending own cancellations visible as canceling rows after archive", () => {
        const repository = new SqliteBiddingBidBookRepository();
        seedBiddingRuntime(collectionId);
        db.prepare(
            "UPDATE trading_jobs SET status = @status WHERE job_id = @jobId",
        ).run({
            status: TRADING_JOB_STATUS.Archived,
            jobId: "collection-job",
        });
        insertIndexedOrder({
            collectionId,
            id: "pending-cancel-own-order",
            maker: BIDDING_MAKER_ADDRESS,
            updatedAt: "2026-05-17T00:00:01Z",
        });
        insertPendingOrderCancellation({
            collectionId,
            orderId: "pending-cancel-own-order",
        });

        const bidBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });

        assert.deepEqual(
            bidBook.bids.map((bid) => ({
                orderId: bid.orderId,
                materialization: bid.materialization,
                placedAt: bid.placedAt,
                validUntil: bid.validUntil,
            })),
            [
                {
                    orderId: "pending-cancel-own-order",
                    materialization: {
                        kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
                        jobId: "collection-job",
                        status: TRADING_JOB_STATUS.Archived,
                        phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling,
                    },
                    placedAt: "2026-05-17T00:00:00Z",
                    validUntil: 1_900_000_000,
                },
            ],
        );
    });

    it("keeps indexed order timing off active own job rows in orders fallback", () => {
        const repository = new SqliteBiddingBidBookRepository();
        seedBiddingRuntime(collectionId);
        insertIndexedOrder({
            collectionId,
            id: "own-indexed-order",
            maker: BIDDING_MAKER_ADDRESS,
            updatedAt: "2026-05-17T00:00:01Z",
        });
        insertIndexedOrder({
            collectionId,
            id: "opponent-indexed-order",
            maker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            updatedAt: "2026-05-17T00:00:01Z",
        });

        const queuedBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });
        const queuedOwnRows = queuedBook.bids.filter((bid) => bid.isOwn);
        const queuedOpponent = queuedBook.bids.find(
            (bid) => bid.orderId === "opponent-indexed-order",
        );

        assert.equal(queuedBook.state.source, TRADING_BIDDING_BID_BOOK_SOURCE.Orders);
        assert.deepEqual(
            queuedOwnRows.map((bid) => ({
                orderId: bid.orderId,
                materializationKind: bid.materialization.kind,
                placedAt: bid.placedAt,
                validUntil: bid.validUntil,
                ownStatus: bid.ownStatus,
            })),
            [
                {
                    orderId: "job-intent:collection-job",
                    materializationKind:
                        TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
                    placedAt: null,
                    validUntil: null,
                    ownStatus: null,
                },
            ],
        );
        assert.equal(queuedOpponent?.placedAt, INDEXED_ORDER_PLACED_AT);
        assert.equal(queuedOpponent?.validUntil, 4_000_000_000);

        seedJobRuntimeState({
            jobId: "collection-job",
            currentPriceWei: "150",
            activeOrderId: "own-indexed-order",
            activeOrderPlacedAt: "2026-05-17T00:00:00Z",
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "250",
        });

        const runtimeBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });
        const runtimeOwnRows = runtimeBook.bids.filter((bid) => bid.isOwn);

        assert.deepEqual(
            runtimeOwnRows.map((bid) => ({
                orderId: bid.orderId,
                materializationKind: bid.materialization.kind,
                placedAt: bid.placedAt,
                validUntil: bid.validUntil,
                ownStatus: bid.ownStatus,
            })),
            [
                {
                    orderId: "own-indexed-order",
                    materializationKind:
                        TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
                    placedAt: "2026-05-17T00:00:00Z",
                    validUntil: 1_900_000_000,
                    ownStatus: {
                        position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
                        constraints: [
                            TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling,
                        ],
                        job: {
                            jobId: "collection-job",
                            revision: 1,
                            status: TRADING_JOB_STATUS.Enabled,
                        },
                    },
                },
            ],
        );
    });

    it("adds admin-only own job intent overlays for queued and paused jobs", () => {
        const repository = new SqliteBiddingBidBookRepository();
        seedBiddingRuntime(collectionId);
        insertProjectedState(collectionId, Date.now());
        seedTraitBiddingJob({
            collectionId,
            jobId: "paused-trait-job",
            status: TRADING_JOB_STATUS.Paused,
            floorWei: "300",
            ceilingWei: "400",
            traits: [{ type: "Mode", value: "Terrain" }],
        });

        const publicBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: false,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });
        assert.deepEqual(publicBook.bids, []);
        assert.equal(publicBook.ownMakerAddress, null);

        const queuedCollectionBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });
        assert.deepEqual(
            queuedCollectionBook.bids.map((bid) => ({
                orderId: bid.orderId,
                materialization: bid.materialization,
                price: bid.price,
                maker: bid.maker,
            })),
            [
                {
                    orderId: "job-intent:collection-job",
                    materialization: {
                        kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
                        jobId: "collection-job",
                        status: TRADING_JOB_STATUS.Enabled,
                        phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
                    },
                    price: {
                        kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Range,
                        floorWei: "100",
                        floorEth: "0.0000000000000001",
                        ceilingWei: "200",
                        ceilingEth: "0.0000000000000002",
                    },
                    maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                },
            ],
        );

        seedJobRuntimeState({
            jobId: "collection-job",
            currentPriceWei: "150",
            activeOrderId: "0xruntime-order",
            activeOrderPlacedAt: "2026-05-17T00:00:00Z",
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "250",
        });
        const runtimeCollectionBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });
        assert.equal(runtimeCollectionBook.bids[0]?.orderId, "0xruntime-order");
        assert.equal(runtimeCollectionBook.bids[0]?.price.kind, TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact);
        assert.equal(
            runtimeCollectionBook.bids[0]
                ? persistedBidBookRowEffectiveWei(runtimeCollectionBook.bids[0])
                : null,
            "150",
        );
        assert.equal(
            runtimeCollectionBook.bids[0]?.materialization.phase,
            TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
        );
        assert.equal(runtimeCollectionBook.bids[0]?.placedAt, "2026-05-17T00:00:00Z");
        assert.equal(runtimeCollectionBook.bids[0]?.validUntil, 1900000000);
        assert.deepEqual(runtimeCollectionBook.bids[0]?.ownStatus, {
            position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            job: {
                jobId: "collection-job",
                revision: 1,
                status: TRADING_JOB_STATUS.Enabled,
            },
        });

        const pausedTraitBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });
        assert.deepEqual(pausedTraitBook.bids.map((bid) => bid.orderId), [
            "job-intent:paused-trait-job",
        ]);
        assert.equal(
            pausedTraitBook.bids[0]?.materialization.phase,
            TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused,
        );

        const tokenBook = repository.listTokenBidBook({
            chainId: 1,
            collectionId,
            tokenId: "5",
            tokenTraits: [{ type: "Mode", value: "Terrain" }],
            includeOwnJobContext: true,
        });
        assert.deepEqual(
            tokenBook.bids.map((bid) => bid.orderId),
            ["job-intent:paused-trait-job", "0xruntime-order"],
        );
    });

    it("uses the bot runtime decision instead of exact-scope bid-book inference", () => {
        const repository = new SqliteBiddingBidBookRepository();
        seedBiddingRuntime(collectionId);
        seedTokenBiddingJob({
            collectionId,
            jobId: "token-job",
            tokenId: "6236",
            floorWei: "150",
            ceilingWei: "150",
        });
        insertProjectedState(collectionId, Date.now());
        insertProjectedBid({
            collectionId,
            orderId: "own-token",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
            scopeLabel: "#6236",
            tokenId: "6236",
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            priceWei: "150",
        });
        insertProjectedBid({
            collectionId,
            orderId: "opponent-collection",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            scopeLabel: "collection",
            maker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            priceWei: "2500",
        });
        seedJobRuntimeState({
            jobId: "token-job",
            currentPriceWei: "150",
            activeOrderId: "own-token",
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "2500",
        });

        const tokenBook = repository.listTokenBidBook({
            chainId: 1,
            collectionId,
            tokenId: "6236",
            tokenTraits: [],
            includeOwnJobContext: true,
        });
        const ownTokenBid = tokenBook.bids.find(
            (bid) => bid.orderId === "own-token",
        );

        assert.deepEqual(ownTokenBid?.ownStatus, {
            position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            job: {
                jobId: "token-job",
                revision: 1,
                status: TRADING_JOB_STATUS.Enabled,
            },
        });
    });

    it("moves a trait job from queued intent to one runtime market row and suppresses it after archive", () => {
        const jobsRepository = new SqliteBiddingJobsRepository();
        const bidBookRepository = new SqliteBiddingBidBookRepository();
        const targetTraits = [{ type: "Biome", value: "42" }];
        seedBiddingBotRuntimeState();
        insertProjectedState(collectionId, Date.now());

        const created = jobsRepository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "150",
            ceilingWei: "150",
            deltaWei: "1",
            quantity: 1,
            targetTraits,
        });
        const queuedBook = bidBookRepository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [{ key: "Biome", value: "42" }],
            selectedTraitRanges: [],
        });

        assert.equal(queuedBook.bids.length, 1);
        assert.equal(
            queuedBook.bids[0]?.materialization.kind,
            TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
        );
        assert.equal(
            queuedBook.bids[0]?.materialization.jobId,
            created.job.jobId,
        );
        assert.equal(
            queuedBook.bids[0]?.materialization.phase,
            TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
        );

        insertProjectedBid({
            collectionId,
            orderId: "own-trait-order",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
            scopeLabel: "Biome=42",
            scopeTraits: targetTraits,
            maker: BIDDING_MAKER_ADDRESS,
            priceWei: "150",
        });
        insertProjectedBid({
            collectionId,
            orderId: "opponent-trait-order",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
            scopeLabel: "Biome=42",
            scopeTraits: targetTraits,
            priceWei: "250",
        });
        seedJobRuntimeState({
            jobId: created.job.jobId,
            currentPriceWei: "150",
            activeOrderId: "own-trait-order",
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "250",
        });

        const placedBook = bidBookRepository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [{ key: "Biome", value: "42" }],
            selectedTraitRanges: [],
        });
        const ownPlacedBid = placedBook.bids.find(
            (bid) => bid.orderId === "own-trait-order",
        );

        assert.deepEqual(
            placedBook.bids.map((bid) => bid.orderId),
            ["opponent-trait-order", "own-trait-order"],
        );
        assert.equal(
            placedBook.bids.some(
                (bid) =>
                    bid.materialization.kind ===
                    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
            ),
            false,
        );
        assert.deepEqual(ownPlacedBid?.ownStatus, {
            position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            job: {
                jobId: created.job.jobId,
                revision: 1,
                status: TRADING_JOB_STATUS.Enabled,
            },
        });
        assert.deepEqual(ownPlacedBid?.price, exactBidBookRowPrice("150"));

        const archived = jobsRepository.archiveJobById({
            chainId: 1,
            collectionId,
            jobId: created.job.jobId,
        });
        assert.ok(archived);
        insertIndexedOrder({
            collectionId,
            id: "own-trait-order",
            maker: BIDDING_MAKER_ADDRESS,
            scopeKind: "attribute",
            sourceSchema: {
                kind: TOKEN_SET_SCHEMA_KIND.Attribute,
                data: {
                    collection: COLLECTION_ADDRESS.toLowerCase(),
                    attributes: [{ key: "Biome", value: "42" }],
                },
            },
            updatedAt: "2026-05-17T00:00:01Z",
        });
        insertIndexedOrder({
            collectionId,
            id: "opponent-trait-order",
            scopeKind: "attribute",
            sourceSchema: {
                kind: TOKEN_SET_SCHEMA_KIND.Attribute,
                data: {
                    collection: COLLECTION_ADDRESS.toLowerCase(),
                    attributes: [{ key: "Biome", value: "42" }],
                },
            },
            updatedAt: "2026-05-17T00:00:01Z",
        });
        insertCompletedOrderCancellation({
            collectionId,
            orderId: "own-trait-order",
            jobId: created.job.jobId,
        });

        const archivedBook = bidBookRepository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [{ key: "Biome", value: "42" }],
            selectedTraitRanges: [],
        });

        assert.deepEqual(
            archivedBook.bids.map((bid) => bid.orderId),
            ["opponent-trait-order"],
        );
        assert.equal(
            archivedBook.bids.some((bid) => bid.maker === BIDDING_MAKER_ADDRESS),
            false,
        );

        const recreated = jobsRepository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "175",
            ceilingWei: "225",
            deltaWei: "1",
            quantity: 1,
            targetTraits,
        });
        const recreatedBook = bidBookRepository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: true,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [{ key: "Biome", value: "42" }],
            selectedTraitRanges: [],
        });
        const recreatedIntent = recreatedBook.bids.find(
            (bid) =>
                bid.materialization.kind ===
                TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
        );

        assert.notEqual(recreated.job.jobId, created.job.jobId);
        assert.equal(
            recreatedBook.bids.some((bid) => bid.orderId === "own-trait-order"),
            false,
        );
        assert.deepEqual(
            recreatedBook.bids
                .filter((bid) => bid.maker === BIDDING_MAKER_ADDRESS)
                .map((bid) => ({
                    jobId: bid.materialization.jobId,
                    kind: bid.materialization.kind,
                    phase: bid.materialization.phase,
                    price: bid.price,
                    placedAt: bid.placedAt,
                    ownStatus: bid.ownStatus,
                })),
            [
                {
                    jobId: recreated.job.jobId,
                    kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
                    phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
                    price: {
                        kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Range,
                        floorWei: "175",
                        floorEth: "0.000000000000000175",
                        ceilingWei: "225",
                        ceilingEth: "0.000000000000000225",
                    },
                    placedAt: null,
                    ownStatus: null,
                },
            ],
        );
        assert.ok(recreatedIntent);
    });

    it("requires fresh bot runtime state after price tier reapply clears active runtime", () => {
        const jobsRepository = new SqliteBiddingJobsRepository();
        const bidBookRepository = new SqliteBiddingBidBookRepository();
        seedBiddingBotRuntimeState();
        insertProjectedState(collectionId, Date.now());

        const created = jobsRepository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "777",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100",
            ceilingWei: "200",
            deltaWei: "1",
            priceTierId: "tier-base",
            pricingSource: {
                kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                tierId: "tier-base",
                tierName: "base",
                resolvedAt: "2026-01-01T00:00:00Z",
                resolvedFloorWei: "100",
                resolvedCeilingWei: "200",
                deltaWei: "1",
            },
        });
        insertProjectedBid({
            collectionId,
            orderId: "own-tier-order-old",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
            scopeLabel: "#777",
            tokenId: "777",
            maker: BIDDING_MAKER_ADDRESS,
            priceWei: "150",
        });
        insertProjectedBid({
            collectionId,
            orderId: "opponent-tier-order",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
            scopeLabel: "#777",
            tokenId: "777",
            priceWei: "250",
        });
        seedJobRuntimeState({
            jobId: created.job.jobId,
            currentPriceWei: "150",
            activeOrderId: "own-tier-order-old",
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "250",
        });

        const beforeReapply = bidBookRepository.listTokenBidBook({
            chainId: 1,
            collectionId,
            tokenId: "777",
            tokenTraits: [],
            includeOwnJobContext: true,
        });
        assert.deepEqual(
            beforeReapply.bids.find((bid) => bid.orderId === "own-tier-order-old")
                ?.ownStatus,
            {
                position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
                constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
                job: {
                    jobId: created.job.jobId,
                    revision: 1,
                    status: TRADING_JOB_STATUS.Enabled,
                },
            },
        );

        const reapply = jobsRepository.updateJobsPricingById([
            {
                chainId: 1,
                collectionId,
                jobId: created.job.jobId,
                floorWei: "120",
                ceilingWei: "180",
                deltaWei: "1",
                priceTierId: "tier-base",
                pricingSource: {
                    kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                    tierId: "tier-base",
                    tierName: "base",
                    resolvedAt: "2026-01-02T00:00:00Z",
                    resolvedFloorWei: "120",
                    resolvedCeilingWei: "180",
                    deltaWei: "1",
                },
            },
        ]);
        const afterReapply = bidBookRepository.listTokenBidBook({
            chainId: 1,
            collectionId,
            tokenId: "777",
            tokenTraits: [],
            includeOwnJobContext: true,
        });
        const queuedIntent = afterReapply.bids.find(
            (bid) =>
                bid.materialization.kind ===
                TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
        );

        assert.equal(reapply.jobs[0]?.runtime, null);
        assert.equal(reapply.jobs[0]?.revision, 2);
        assert.equal(
            afterReapply.bids.some((bid) => bid.orderId === "own-tier-order-old"),
            false,
        );
        assert.equal(queuedIntent?.materialization.jobId, created.job.jobId);
        assert.equal(
            queuedIntent?.materialization.phase,
            TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
        );
        assert.deepEqual(queuedIntent?.price, {
            kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Range,
            floorWei: "120",
            floorEth: "0.00000000000000012",
            ceilingWei: "180",
            ceilingEth: "0.00000000000000018",
        });
        assert.equal(queuedIntent?.ownStatus, null);
        assert.equal(
            afterReapply.bids.some((bid) => bid.ownStatus !== null),
            false,
        );

        insertProjectedBid({
            collectionId,
            orderId: "own-tier-order-fresh",
            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
            scopeLabel: "#777",
            tokenId: "777",
            maker: BIDDING_MAKER_ADDRESS,
            priceWei: "180",
        });
        seedJobRuntimeState({
            jobId: created.job.jobId,
            jobRevision: 2,
            currentPriceWei: "180",
            activeOrderId: "own-tier-order-fresh",
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "250",
        });

        const afterFreshRuntime = bidBookRepository.listTokenBidBook({
            chainId: 1,
            collectionId,
            tokenId: "777",
            tokenTraits: [],
            includeOwnJobContext: true,
        });
        const freshOwnBid = afterFreshRuntime.bids.find(
            (bid) => bid.orderId === "own-tier-order-fresh",
        );

        assert.equal(
            afterFreshRuntime.bids.some(
                (bid) => bid.orderId === "own-tier-order-old",
            ),
            false,
        );
        assert.deepEqual(freshOwnBid?.ownStatus, {
            position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            job: {
                jobId: created.job.jobId,
                revision: 2,
                status: TRADING_JOB_STATUS.Enabled,
            },
        });
        assert.deepEqual(freshOwnBid?.price, exactBidBookRowPrice("180"));
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
            includeOwnJobContext: false,
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
            includeOwnJobContext: false,
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
            includeOwnJobContext: false,
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

    it("falls back to indexed order columns when raw payloads are unusable", () => {
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
            id: "normalized-fallback",
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            rawRestData: { order_hash: "normalized-fallback" },
            rawStreamData: {
                raw: "payload that must not be parsed for bid-book display",
            },
            updatedAt: "2026-05-15T01:00:00Z",
        });

        const bidBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: false,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [],
            selectedTraitRanges: [],
        });

        assert.equal(bidBook.state.source, TRADING_BIDDING_BID_BOOK_SOURCE.Orders);
        assert.equal(bidBook.state.updatedAt, "2026-05-15T01:00:00Z");
        assert.equal(bidBook.ownMakerAddress, null);
        assert.deepEqual(
            bidBook.bids.map((bid) => ({
                orderId: bid.orderId,
                maker: bid.maker,
                isOwn: bid.isOwn,
                price: bid.price,
                placedAt: bid.placedAt,
            })),
            [
                {
                    orderId: "normalized-fallback",
                    maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    isOwn: false,
                    price: exactBidBookRowPrice("100000000000000000"),
                    placedAt: INDEXED_ORDER_PLACED_AT,
                },
            ],
        );
    });

    it("maps indexed trait orders from normalized source schema for trait matching", () => {
        const repository = new SqliteBiddingBidBookRepository();
        insertIndexedOrder({
            collectionId,
            id: "trait-indexed-order",
            scopeKind: "attribute",
            sourceSchema: {
                kind: TOKEN_SET_SCHEMA_KIND.Attribute,
                data: {
                    collection: COLLECTION_ADDRESS.toLowerCase(),
                    attributes: [{ key: "Biome", value: "42" }],
                },
            },
            rawRestData: {
                raw: "payload that must not be parsed for trait criteria",
            },
            rawStreamData: null,
            updatedAt: "2026-05-15T03:00:00Z",
        });
        insertIndexedOrder({
            collectionId,
            id: "collection-indexed-order",
            rawRestData: makeOpenSeaBuyOrderPayload({
                orderId: "collection-indexed-order",
                maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                priceWei: "100000000000000000",
                validFrom: 1,
                validUntil: 4_000_000_000,
            }),
            rawStreamData: null,
            updatedAt: "2026-05-15T02:00:00Z",
        });

        const collectionBidBook = repository.listCollectionBidBook({
            chainId: 1,
            collectionId,
            includeOwnJobContext: false,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            selectedTraits: [{ key: "Biome", value: "42" }],
            selectedTraitRanges: [],
        });
        const tokenBidBook = repository.listTokenBidBook({
            chainId: 1,
            collectionId,
            tokenId: "100",
            tokenTraits: [{ type: "Biome", value: "42" }],
            includeOwnJobContext: false,
        });

        assert.deepEqual(
            collectionBidBook.bids.map((bid) => ({
                orderId: bid.orderId,
                scopeKind: bid.scopeKind,
                scopeLabel: bid.scopeLabel,
                scopeTraits: bid.scopeTraits,
            })),
            [
                {
                    orderId: "trait-indexed-order",
                    scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
                    scopeLabel: "Biome=42",
                    scopeTraits: [{ type: "Biome", value: "42" }],
                },
            ],
        );
        assert.deepEqual(
            tokenBidBook.bids.map((bid) => bid.orderId),
            ["collection-indexed-order", "trait-indexed-order"],
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
    seedBiddingBotRuntimeState();
}

function seedBiddingBotRuntimeState(): void {
    db.prepare(
        "INSERT INTO trading_bot_runtime_state " +
            "(bot_kind, chain_id, wallet_id, address, state, heartbeat_at, started_at, updated_at, last_error) " +
            "VALUES (?, 1, 'wallet-1', ?, ?, ?, ?, ?, NULL)",
    ).run(
        TRADING_BOT_KIND.Bidding,
        BIDDING_MAKER_ADDRESS,
        TRADING_BOT_RUNTIME_STATE.Running,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
    );
}

function seedTraitBiddingJob(input: {
    collectionId: number;
    jobId: string;
    status: typeof TRADING_JOB_STATUS.Enabled | typeof TRADING_JOB_STATUS.Paused;
    floorWei: string;
    ceilingWei: string;
    traits: Array<{ type: string; value: string }>;
}): void {
    db.prepare(
        "INSERT INTO trading_jobs " +
            "(job_id, bot_kind, chain_id, collection_id, status, target_kind, token_id, revision) " +
            "VALUES (@jobId, @botKind, 1, @collectionId, @status, @targetKind, NULL, 1)",
    ).run({
        jobId: input.jobId,
        botKind: TRADING_BOT_KIND.Bidding,
        collectionId: input.collectionId,
        status: input.status,
        targetKind: TRADING_JOB_TARGET_KIND.Collection,
    });
    db.prepare(
        "INSERT INTO trading_bidding_job_specs " +
            "(job_id, floor_wei, ceiling_wei, delta_wei, quantity, target_traits_json) " +
            "VALUES (@jobId, @floorWei, @ceilingWei, '1', 1, @traitsJson)",
    ).run({
        jobId: input.jobId,
        floorWei: input.floorWei,
        ceilingWei: input.ceilingWei,
        traitsJson: JSON.stringify(input.traits),
    });
}

function seedTokenBiddingJob(input: {
    collectionId: number;
    jobId: string;
    tokenId: string;
    floorWei: string;
    ceilingWei: string;
}): void {
    db.prepare(
        "INSERT INTO trading_jobs " +
            "(job_id, bot_kind, chain_id, collection_id, status, target_kind, token_id, revision) " +
            "VALUES (@jobId, @botKind, 1, @collectionId, @status, @targetKind, @tokenId, 1)",
    ).run({
        jobId: input.jobId,
        botKind: TRADING_BOT_KIND.Bidding,
        collectionId: input.collectionId,
        status: TRADING_JOB_STATUS.Enabled,
        targetKind: TRADING_JOB_TARGET_KIND.Token,
        tokenId: input.tokenId,
    });
    db.prepare(
        "INSERT INTO trading_bidding_job_specs " +
            "(job_id, floor_wei, ceiling_wei, delta_wei, quantity, target_traits_json) " +
            "VALUES (@jobId, @floorWei, @ceilingWei, '1', NULL, '[]')",
    ).run({
        jobId: input.jobId,
        floorWei: input.floorWei,
        ceilingWei: input.ceilingWei,
    });
}

function seedJobRuntimeState(input: {
    jobId: string;
    jobRevision?: number;
    currentPriceWei: string;
    activeOrderId: string;
    activeOrderPlacedAt?: string | null;
    bidPosition?: string | null;
    bidConstraints?: string[];
    competitorPriceWei?: string | null;
}): void {
    db.prepare(
        "INSERT INTO trading_bidding_job_runtime_state " +
            "(job_id, job_revision, current_price_wei, active_order_id, active_protocol_address, active_order_placed_at, active_expiration_time_ms, bid_position, bid_constraints_json, competitor_price_wei, updated_at) " +
            "VALUES (@jobId, @jobRevision, @currentPriceWei, @activeOrderId, NULL, @activeOrderPlacedAt, 1900000000000, @bidPosition, @bidConstraintsJson, @competitorPriceWei, @updatedAt) " +
            "ON CONFLICT(job_id) DO UPDATE SET " +
            "job_revision = excluded.job_revision, " +
            "current_price_wei = excluded.current_price_wei, " +
            "active_order_id = excluded.active_order_id, " +
            "active_protocol_address = excluded.active_protocol_address, " +
            "active_order_placed_at = excluded.active_order_placed_at, " +
            "active_expiration_time_ms = excluded.active_expiration_time_ms, " +
            "bid_position = excluded.bid_position, " +
            "bid_constraints_json = excluded.bid_constraints_json, " +
            "competitor_price_wei = excluded.competitor_price_wei, " +
            "updated_at = excluded.updated_at",
    ).run({
        jobId: input.jobId,
        jobRevision: input.jobRevision ?? 1,
        currentPriceWei: input.currentPriceWei,
        activeOrderId: input.activeOrderId,
        activeOrderPlacedAt: input.activeOrderPlacedAt ?? null,
        bidPosition: input.bidPosition ?? null,
        bidConstraintsJson: JSON.stringify(input.bidConstraints ?? []),
        competitorPriceWei: input.competitorPriceWei ?? null,
        updatedAt: "2026-05-17T00:00:00Z",
    });
}

function insertCompletedOrderCancellation(input: {
    collectionId: number;
    orderId: string;
    jobId?: string;
    maker?: string;
}): void {
    db.prepare(
        "INSERT INTO trading_bidding_order_cancellations " +
            "(order_id, job_id, job_revision, chain_id, collection_id, maker, price_wei, protocol_address, placed_at, expiration_time_ms, requested_at, completed_at, cancellation_error, updated_at) " +
            "VALUES (@orderId, @jobId, 1, 1, @collectionId, @maker, @priceWei, @protocolAddress, @placedAt, @expirationTimeMs, @requestedAt, @completedAt, NULL, @updatedAt) " +
            "ON CONFLICT(order_id) DO UPDATE SET " +
            "completed_at = excluded.completed_at, " +
            "cancellation_error = NULL, " +
            "updated_at = excluded.updated_at",
    ).run({
        orderId: input.orderId,
        jobId: input.jobId ?? "collection-job",
        collectionId: input.collectionId,
        maker: input.maker ?? BIDDING_MAKER_ADDRESS,
        priceWei: "100",
        protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
        placedAt: "2026-05-17T00:00:00Z",
        expirationTimeMs: 1_900_000_000_000,
        requestedAt: "2026-05-17T00:00:00Z",
        completedAt: "2026-05-17T00:00:01Z",
        updatedAt: "2026-05-17T00:00:01Z",
    });
}

function insertFailedOrderCancellation(input: {
    collectionId: number;
    orderId: string;
    jobId?: string;
    maker?: string;
}): void {
    db.prepare(
        "INSERT INTO trading_bidding_order_cancellations " +
            "(order_id, job_id, job_revision, chain_id, collection_id, maker, price_wei, protocol_address, placed_at, expiration_time_ms, requested_at, completed_at, cancellation_error, updated_at) " +
            "VALUES (@orderId, @jobId, 1, 1, @collectionId, @maker, @priceWei, @protocolAddress, @placedAt, @expirationTimeMs, @requestedAt, NULL, @cancellationError, @updatedAt)",
    ).run({
        orderId: input.orderId,
        jobId: input.jobId ?? "collection-job",
        collectionId: input.collectionId,
        maker: input.maker ?? BIDDING_MAKER_ADDRESS,
        priceWei: "100",
        protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
        placedAt: "2026-05-17T00:00:00Z",
        expirationTimeMs: 1_900_000_000_000,
        requestedAt: "2026-05-17T00:00:00Z",
        cancellationError: "opensea cancel failed",
        updatedAt: "2026-05-17T00:00:01Z",
    });
}

function insertPendingOrderCancellation(input: {
    collectionId: number;
    orderId: string;
    jobId?: string;
    maker?: string;
}): void {
    db.prepare(
        "INSERT INTO trading_bidding_order_cancellations " +
            "(order_id, job_id, job_revision, chain_id, collection_id, maker, price_wei, protocol_address, placed_at, expiration_time_ms, requested_at, completed_at, cancellation_error, updated_at) " +
            "VALUES (@orderId, @jobId, 1, 1, @collectionId, @maker, @priceWei, @protocolAddress, @placedAt, @expirationTimeMs, @requestedAt, NULL, NULL, @updatedAt)",
    ).run({
        orderId: input.orderId,
        jobId: input.jobId ?? "collection-job",
        collectionId: input.collectionId,
        maker: input.maker ?? BIDDING_MAKER_ADDRESS,
        priceWei: "100",
        protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
        placedAt: "2026-05-17T00:00:00Z",
        expirationTimeMs: 1_900_000_000_000,
        requestedAt: "2026-05-17T00:00:00Z",
        updatedAt: "2026-05-17T00:00:00Z",
    });
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
    placedAt?: string | null;
    validUntil?: number | null;
}): void {
    db.prepare(
        "INSERT INTO trading_bidding_bid_book_rows " +
            "(chain_id, collection_id, order_id, source, scope_kind, scope_label, token_id, scope_traits_json, encoded_token_ids, maker, is_own, price_wei, quantity, currency_address, valid_until, placed_at, snapshot_refreshed_at_ms) " +
            "VALUES (1, @collectionId, @orderId, @source, @scopeKind, @scopeLabel, @tokenId, @scopeTraitsJson, @encodedTokenIds, @maker, 0, @priceWei, '1', @currencyAddress, @validUntil, @placedAt, @snapshotRefreshedAtMs)",
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
        validUntil: input.validUntil ?? null,
        placedAt: input.placedAt ?? null,
        snapshotRefreshedAtMs: Date.now(),
    });
}

function insertIndexedOrder(input: {
    collectionId: number;
    id: string;
    maker?: string;
    scopeKind?: string;
    tokenId?: string | null;
    sourceEncodedTokenIds?: string | null;
    sourceSchema?: unknown;
    rawRestData?: unknown;
    rawStreamData?: unknown;
    updatedAt: string;
}): void {
    db.prepare(
        "INSERT INTO orders " +
            "(id, chain_id, collection_id, kind, side, source, maker, taker, contract_address, token_id, source_scope_kind, source_encoded_token_ids, source_schema_json, quantity, price, currency, valid_from, valid_until, fillability_status, source_status, seaport_data_json, raw_rest_data, raw_stream_data, created_at, updated_at) " +
            "VALUES (@id, 1, @collectionId, 'seaport', 'buy', 'opensea', @maker, NULL, @contractAddress, @tokenId, @scopeKind, @sourceEncodedTokenIds, @sourceSchemaJson, '1', '100000000000000000', @currency, @validFrom, 4000000000, 'fillable', 'active', NULL, @rawRestData, @rawStreamData, @createdAt, @updatedAt)",
    ).run({
        id: input.id,
        collectionId: input.collectionId,
        maker: input.maker ?? "0x9999999999999999999999999999999999999999",
        contractAddress: COLLECTION_ADDRESS.toLowerCase(),
        tokenId: input.tokenId ?? null,
        scopeKind: input.scopeKind ?? "collection",
        sourceEncodedTokenIds: input.sourceEncodedTokenIds ?? null,
        sourceSchemaJson:
            input.sourceSchema === undefined
                ? null
                : JSON.stringify(input.sourceSchema),
        currency: WETH_ADDRESS.toLowerCase(),
        rawRestData:
            input.rawRestData === undefined
                ? null
                : JSON.stringify(input.rawRestData),
        rawStreamData:
            input.rawStreamData === undefined
                ? null
                : JSON.stringify(input.rawStreamData),
        validFrom: Math.floor(Date.parse(INDEXED_ORDER_PLACED_AT) / 1000),
        createdAt: INDEXED_ORDER_PLACED_AT,
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
