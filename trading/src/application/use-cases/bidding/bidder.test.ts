import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
    type TradingBiddingJobRuntimeBidPosition,
    type TradingBiddingJobRuntimeConstraint,
} from "@artgod/shared/types";
import {
    MarketEvent,
    Scope,
    TraitCriterion,
    Type,
} from "../../../domain/market/event.js";
import {
    TokenMetadataRepository,
    type TokenMetadataTrait,
} from "../../../domain/market/token-metadata-repository.js";
import {
    BIDDER_TARGET_TYPE,
    BidderJob,
} from "../../../domain/market/strategy/job.js";
import { Bidder } from "./bidder.js";
import {
    BIDDING_ORDER_RECOVERY_REASON,
    BIDDING_ORDER_RECOVERY_STATUS,
    type BiddingOrderRecoveryResult,
} from "./bidding-service.js";

class FakeBiddingService {
    public activeTokenOfferByMaker: unknown = null;
    public activeTokenOfferByMakerImpl?: (job: BidderJob) => Promise<unknown>;
    public tokenOfferLookupJobIds: string[] = [];
    public activeOffers: unknown[] = [];
    public activeOffersImpl?: (job: BidderJob) => Promise<unknown[]>;
    public orderLookupResult: BiddingOrderRecoveryResult = {
        status: BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing,
    };
    public orderLookups: Array<{
        orderHash: string;
        protocolAddress?: string;
        collectionAddress?: string;
        tokenId?: string;
        collectionSlug?: string;
    }> = [];
    public placedAmounts: bigint[] = [];
    public placedExpirationTime?: number;
    public placeError: Error | null = null;
    public canceledOrderIds: string[] = [];
    public cancelError: Error | null = null;

    async getActiveOffers(job: BidderJob): Promise<unknown[]> {
        if (this.activeOffersImpl) {
            return await this.activeOffersImpl(job);
        }
        return this.activeOffers;
    }

    async getActiveTokenOfferByMaker(job: BidderJob): Promise<unknown> {
        this.tokenOfferLookupJobIds.push(job.id);
        if (this.activeTokenOfferByMakerImpl) {
            return await this.activeTokenOfferByMakerImpl(job);
        }
        return this.activeTokenOfferByMaker;
    }

    async getOrder(
        orderHash: string,
        protocolAddress?: string,
        collectionAddress?: string,
        tokenId?: string,
        collectionSlug?: string,
    ): Promise<BiddingOrderRecoveryResult> {
        this.orderLookups.push({
            orderHash,
            protocolAddress,
            collectionAddress,
            tokenId,
            collectionSlug,
        });
        return this.orderLookupResult;
    }

    async placeOffer(
        _job: BidderJob,
        amount: bigint,
    ): Promise<{
        orderHash: string;
        protocolAddress: string;
        placedAt: string;
        expirationTime?: number;
    }> {
        if (this.placeError) {
            throw this.placeError;
        }
        this.placedAmounts.push(amount);
        return {
            orderHash: "0xhash",
            protocolAddress: "0xprotocol",
            placedAt: "2026-05-17T00:00:00Z",
            expirationTime: this.placedExpirationTime,
        };
    }

    async cancelOffer(_job: BidderJob, order: { id: string }): Promise<void> {
        if (this.cancelError) {
            throw this.cancelError;
        }
        this.canceledOrderIds.push(order.id);
    }
}

class FakeMakerWethBalanceService {
    public calls = 0;

    constructor(private readonly balance: bigint) {}

    async getWethBalance(_address: string): Promise<bigint> {
        this.calls++;
        return this.balance;
    }
}

class FakeTokenMetadataRepository implements TokenMetadataRepository {
    constructor(
        private readonly rows: Record<string, TokenMetadataTrait[]> = {},
    ) {}

    async getTraits(
        collectionSlug: string,
        tokenId: string,
    ): Promise<TokenMetadataTrait[]> {
        return this.rows[`${collectionSlug}:${tokenId}`] ?? [];
    }
}

const makeJob = (
    id: string,
    slug: string,
    target: BidderJob["target"],
    currentPrice?: bigint,
    configOverrides: Partial<BidderJob["config"]> = {},
): BidderJob => ({
    id,
    revision: 1,
    network: "eth",
    collectionAddress: "0xcollection",
    collectionSlug: slug,
    target,
    config: {
        floor: 1n,
        ceiling: 10n,
        delta: 1n,
        ...configOverrides,
    },
    state: currentPrice === undefined ? {} : { currentPrice },
});

const makeEvent = (
    type: Type,
    scope: Scope,
    slug: string,
    tokenId: string,
    price: bigint,
    traitCriteria: TraitCriterion[] = [],
): MarketEvent => {
    const event = new MarketEvent(
        new Date().toISOString(),
        type,
        "0xorder",
        slug,
        tokenId,
        "0xcompetitor",
        1,
        "WETH",
        18,
        scope,
        traitCriteria,
    );

    event.setTotalPrice(price);
    return event;
};

describe("Bidder stream refresh", () => {
    it("returns unique token IDs from token-targeted jobs only", () => {
        const bidder = new Bidder(
            new FakeBiddingService() as any,
            "0xmaker",
            1000,
            { dryRun: true },
        );

        bidder.addJob(
            makeJob("token-a", "terraforms", { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" }),
        );
        bidder.addJob(
            makeJob("token-b", "terraforms", { type: BIDDER_TARGET_TYPE.Token, tokenId: "456" }),
        );
        bidder.addJob(
            makeJob("collection-job", "terraforms", {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
            }),
        );

        assert.deepEqual(bidder.getTokenTargetIds(), ["123", "456"]);
    });

    it("does not refresh non-token jobs on matching collection event", async () => {
        const bidder = new Bidder(
            new FakeBiddingService() as any,
            "0xmaker",
            1000,
            { dryRun: true },
        );
        const refreshedJobIds: string[] = [];

        bidder.addJob(
            makeJob("collection-job", "terraforms", {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
            }),
        );
        bidder.addJob(
            makeJob("trait-job", "terraforms", {
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: { type: "Biome", value: "Desert" },
                competitorTraits: [{ type: "Artifact" }],
            }),
        );
        bidder.addJob(
            makeJob("other-collection-job", "digidaigaku", {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
            }),
        );

        bidder.refreshJob = async (jobId: string) => {
            refreshedJobIds.push(jobId);
        };

        await bidder.refreshMatchingJobs(
            makeEvent(
                Type.CollectionOffer,
                Scope.Collection,
                "terraforms",
                "",
                5n,
            ),
        );

        assert.deepEqual(refreshedJobIds, []);
    });

    it("skips token jobs that do not have a warmed current price yet", async () => {
        const biddingService = new FakeBiddingService();
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: true,
        });
        const refreshedJobIds: string[] = [];

        bidder.addJob(
            makeJob("token-hit", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "123",
            }),
        );

        bidder.refreshJob = async (jobId: string) => {
            refreshedJobIds.push(jobId);
        };

        await bidder.refreshMatchingJobs(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                "terraforms",
                "123",
                5n,
            ),
        );

        assert.deepEqual(refreshedJobIds, []);
    });

    it("skips hot refresh for token jobs that cannot beat the event price by ceiling", async () => {
        const bidder = new Bidder(
            new FakeBiddingService() as any,
            "0xmaker",
            1000,
            { dryRun: true },
        );
        const refreshedJobIds: string[] = [];

        bidder.addJob(
            makeJob(
                "token-low-ceiling",
                "terraforms",
                {
                    type: BIDDER_TARGET_TYPE.Token,
                    tokenId: "123",
                },
                5n,
                { floor: 1n, ceiling: 10n, delta: 1n },
            ),
        );

        bidder.refreshJob = async (jobId: string) => {
            refreshedJobIds.push(jobId);
        };

        await bidder.refreshMatchingJobs(
            makeEvent(
                Type.CollectionOffer,
                Scope.Collection,
                "terraforms",
                "",
                10n,
            ),
        );

        assert.deepEqual(refreshedJobIds, []);
    });

    it("warms currentPrice during bootstrap from a live maker-specific token offer lookup", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeTokenOfferByMaker = {
            id: "0xmy-order",
            price: 5n,
            maker: "0xmaker",
            protocolAddress: "0xprotocol",
            expirationTime: Math.floor(Date.now() / 1000) + 3600,
        };
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: true,
        });
        const refreshedJobIds: string[] = [];
        const job = makeJob("token-hit", "terraforms", {
            type: BIDDER_TARGET_TYPE.Token,
            tokenId: "123",
        });

        bidder.addJob(job);
        bidder.refreshJob = async (jobId: string) => {
            refreshedJobIds.push(jobId);
        };

        await bidder.bootstrapCurrentPrices();
        await bidder.refreshMatchingJobs(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                "terraforms",
                "123",
                6n,
            ),
        );

        assert.deepEqual(refreshedJobIds, ["token-hit"]);
        assert.equal(job.state.currentPrice, 5n);
        assert.equal(job.state.activeOrderId, "0xmy-order");
        assert.ok(job.state.activeExpirationTimeMs !== undefined);
        assert.deepEqual(biddingService.tokenOfferLookupJobIds, ["token-hit"]);
    });

    it("skips bootstrap warm-up when the active maker offer expiration is unavailable", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeTokenOfferByMaker = {
            id: "0xmy-order",
            price: 5n,
            maker: "0xmaker",
            protocolAddress: "0xprotocol",
        };
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: true,
        });
        const job = makeJob("token-hit", "terraforms", {
            type: BIDDER_TARGET_TYPE.Token,
            tokenId: "123",
        });

        bidder.addJob(job);

        await bidder.bootstrapCurrentPrices();

        assert.equal(job.state.currentPrice, undefined);
        assert.equal(job.state.activeOrderId, undefined);
        assert.equal(job.state.activeExpirationTimeMs, undefined);
    });

    it("bootstraps current prices in parallel without exceeding the maximum concurrency of 4", async () => {
        const biddingService = new FakeBiddingService();
        let inFlight = 0;
        let maxInFlight = 0;

        biddingService.activeTokenOfferByMakerImpl = async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 50));
            inFlight--;
            return null;
        };

        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: true,
            bootstrapConcurrency: 4,
        });

        for (let index = 0; index < 8; index++) {
            bidder.addJob(
                makeJob(`token-${index}`, "terraforms", {
                    type: BIDDER_TARGET_TYPE.Token,
                    tokenId: `${index}`,
                }),
            );
        }

        await bidder.bootstrapCurrentPrices();

        assert.ok(
            maxInFlight > 1,
            `Expected bootstrap warmup to run in parallel, got maxInFlight=${maxInFlight}`,
        );
        assert.ok(
            maxInFlight <= 4,
            `Expected bootstrap warmup to stay within 4 workers, got maxInFlight=${maxInFlight}`,
        );
        assert.equal(biddingService.tokenOfferLookupJobIds.length, 8);
    });

    it("runs different jobs concurrently up to the configured job limit during a scan", async () => {
        const biddingService = new FakeBiddingService();
        let inFlight = 0;
        let maxInFlight = 0;

        biddingService.activeOffersImpl = async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 20));
            inFlight--;
            return [];
        };

        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: true,
            maxConcurrentJobs: 2,
        });

        bidder.addJob(
            makeJob("token-1", "terraforms", { type: BIDDER_TARGET_TYPE.Token, tokenId: "1" }),
        );
        bidder.addJob(
            makeJob("token-2", "terraforms", { type: BIDDER_TARGET_TYPE.Token, tokenId: "2" }),
        );
        bidder.addJob(
            makeJob("token-3", "terraforms", { type: BIDDER_TARGET_TYPE.Token, tokenId: "3" }),
        );

        await bidder.scanOnce();

        assert.equal(maxInFlight, 2);
    });

    it("serializes overlapping refreshes for the same job even when global concurrency is higher", async () => {
        const biddingService = new FakeBiddingService();
        let inFlight = 0;
        let maxInFlight = 0;

        biddingService.activeOffersImpl = async (job: BidderJob) => {
            if (job.id !== "token-hit") {
                return [];
            }

            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 20));
            inFlight--;
            return [];
        };

        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: true,
            maxConcurrentJobs: 2,
        });

        bidder.addJob(
            makeJob("token-hit", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "123",
            }),
        );

        await Promise.all([
            bidder.refreshJob("token-hit"),
            bidder.refreshJob("token-hit"),
        ]);

        assert.equal(maxInFlight, 1);
    });

    it("collapses overlapping refresh requests for the same job into a single pending rerun", async () => {
        const biddingService = new FakeBiddingService();
        let callCount = 0;

        biddingService.activeOffersImpl = async (job: BidderJob) => {
            if (job.id !== "token-hit") {
                return [];
            }

            callCount++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return [];
        };

        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: true,
            maxConcurrentJobs: 2,
        });

        bidder.addJob(
            makeJob("token-hit", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "123",
            }),
        );

        await Promise.all([
            bidder.refreshJob("token-hit"),
            bidder.refreshJob("token-hit"),
            bidder.refreshJob("token-hit"),
        ]);

        assert.equal(callCount, 2);
    });

    it("uses the token index and does not do live warm-up during item-scope refresh", async () => {
        const biddingService = new FakeBiddingService();
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: true,
        });

        bidder.addJob(
            makeJob("token-hit", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "123",
            }),
        );
        bidder.addJob(
            makeJob("token-other", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "999",
            }),
        );

        await bidder.refreshMatchingJobs(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                "terraforms",
                "123",
                6n,
            ),
        );

        assert.deepEqual(biddingService.tokenOfferLookupJobIds, []);
    });

    it("only refreshes the exact token job for item bids when the price gate passes", async () => {
        const bidder = new Bidder(
            new FakeBiddingService() as any,
            "0xmaker",
            1000,
            { dryRun: true },
        );
        const refreshedJobIds: string[] = [];

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                5n,
            ),
        );
        bidder.addJob(
            makeJob(
                "token-miss",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "999" },
                5n,
            ),
        );

        bidder.refreshJob = async (jobId: string) => {
            refreshedJobIds.push(jobId);
        };

        await bidder.refreshMatchingJobs(
            makeEvent(
                Type.ItemReceivedBid,
                Scope.Item,
                "terraforms",
                "123",
                6n,
            ),
        );

        assert.deepEqual(refreshedJobIds, ["token-hit"]);
    });

    it("refreshes same-collection token jobs for collection offers when the price gate passes", async () => {
        const bidder = new Bidder(
            new FakeBiddingService() as any,
            "0xmaker",
            1000,
            { dryRun: true },
        );
        const refreshedJobIds: string[] = [];

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                5n,
            ),
        );
        bidder.addJob(
            makeJob(
                "token-price-skip",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "456" },
                7n,
            ),
        );
        bidder.addJob(
            makeJob(
                "token-other-collection",
                "digidaigaku",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                1n,
            ),
        );

        bidder.refreshJob = async (jobId: string) => {
            refreshedJobIds.push(jobId);
        };

        await bidder.refreshMatchingJobs(
            makeEvent(
                Type.CollectionOffer,
                Scope.Collection,
                "terraforms",
                "",
                6n,
            ),
        );

        assert.deepEqual(refreshedJobIds, ["token-hit"]);
    });

    it("does not pre-schedule every broad-event match while one token job is running", async () => {
        const bidder = new Bidder(
            new FakeBiddingService() as any,
            "0xmaker",
            1000,
            { dryRun: true },
        );
        const refreshedJobIds: string[] = [];
        let releaseFirstRefresh!: () => void;
        const firstRefreshGate = new Promise<void>((resolve) => {
            releaseFirstRefresh = resolve;
        });

        bidder.addJob(
            makeJob(
                "token-one",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                5n,
            ),
        );
        bidder.addJob(
            makeJob(
                "token-two",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "456" },
                5n,
            ),
        );

        bidder.refreshJob = async (jobId: string) => {
            refreshedJobIds.push(jobId);
            if (refreshedJobIds.length === 1) {
                await firstRefreshGate;
            }
        };

        const refreshPromise = bidder.refreshMatchingJobs(
            makeEvent(
                Type.CollectionOffer,
                Scope.Collection,
                "terraforms",
                "",
                6n,
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.deepEqual(refreshedJobIds, ["token-one"]);

        releaseFirstRefresh();
        await refreshPromise;

        assert.deepEqual(refreshedJobIds, ["token-one", "token-two"]);
    });

    it("refreshes maker WETH balance into the cache and clamps job ceiling to that cached balance", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [
            { id: "0xother", price: 8n, maker: "0xother" },
        ];
        const makerWethBalanceService = new FakeMakerWethBalanceService(5n);
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            { dryRun: false },
            undefined,
            makerWethBalanceService as any,
        );

        bidder.addJob(
            makeJob("token-hit", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "123",
            }),
        );

        await (bidder as any).refreshCachedMakerWethBalance();
        await bidder.refreshJob("token-hit");

        assert.equal(makerWethBalanceService.calls, 1);
        assert.deepEqual(biddingService.placedAmounts, [5n]);
    });

    it("activates a runtime floor/ceiling override and refreshes immediately", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [];
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
        });

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                undefined,
                { floor: 1n, ceiling: 2n, delta: 1n },
            ),
        );

        await bidder.activateJob("token-hit", {
            floor: 4n,
            ceiling: 4n,
            ttlMs: 1000,
            reason: "approval activity",
        });

        assert.deepEqual(biddingService.placedAmounts, [4n]);
    });

    it("reverts to base config after a runtime override expires and refreshes again", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [];
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
        });

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                undefined,
                { floor: 1n, ceiling: 2n, delta: 1n },
            ),
        );

        await bidder.activateJob("token-hit", {
            floor: 4n,
            ceiling: 4n,
            ttlMs: 20,
            reason: "approval activity",
        });
        await new Promise((resolve) => setTimeout(resolve, 60));

        assert.deepEqual(biddingService.placedAmounts, [4n, 1n]);
    });

    it("rejects runtime override activation for an unknown job", async () => {
        const bidder = new Bidder(
            new FakeBiddingService() as any,
            "0xmaker",
            1000,
            { dryRun: false },
        );

        await assert.rejects(
            bidder.activateJob("missing-job", {
                floor: 1n,
                ceiling: 1n,
                ttlMs: 1000,
            }),
            /Cannot activate unknown job/,
        );
    });

    it("rejects runtime override activation when ttl is invalid", async () => {
        const bidder = new Bidder(
            new FakeBiddingService() as any,
            "0xmaker",
            1000,
            { dryRun: false },
        );
        bidder.addJob(
            makeJob("token-hit", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "123",
            }),
        );

        await assert.rejects(
            bidder.activateJob("token-hit", {
                floor: 1n,
                ceiling: 1n,
                ttlMs: 0,
            }),
            /ttlMs must be > 0/,
        );
    });

    it("rejects runtime override activation when floor is above ceiling", async () => {
        const bidder = new Bidder(
            new FakeBiddingService() as any,
            "0xmaker",
            1000,
            { dryRun: false },
        );
        bidder.addJob(
            makeJob("token-hit", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "123",
            }),
        );

        await assert.rejects(
            bidder.activateJob("token-hit", {
                floor: 5n,
                ceiling: 4n,
                ttlMs: 1000,
            }),
            /Activation floor must be <= ceiling/,
        );
    });

    it("replaces an earlier runtime override and ignores the old expiry timer", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [];
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
        });

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                undefined,
                { floor: 1n, ceiling: 2n, delta: 1n },
            ),
        );

        await bidder.activateJob("token-hit", {
            floor: 4n,
            ceiling: 4n,
            ttlMs: 20,
            reason: "first override",
        });
        await bidder.activateJob("token-hit", {
            floor: 6n,
            ceiling: 6n,
            ttlMs: 60,
            reason: "second override",
        });

        await new Promise((resolve) => setTimeout(resolve, 35));
        assert.deepEqual(biddingService.placedAmounts, [4n, 6n]);

        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(biddingService.placedAmounts, [4n, 6n, 1n]);
    });

    it("still clamps a runtime override by the cached maker WETH balance", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [];
        const makerWethBalanceService = new FakeMakerWethBalanceService(5n);
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            { dryRun: false },
            undefined,
            makerWethBalanceService as any,
        );

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                undefined,
                { floor: 1n, ceiling: 2n, delta: 1n },
            ),
        );

        await (bidder as any).refreshCachedMakerWethBalance();
        await bidder.activateJob("token-hit", {
            floor: 7n,
            ceiling: 10n,
            ttlMs: 1000,
            reason: "weth clamp",
        });

        assert.deepEqual(biddingService.placedAmounts, [5n]);
    });

    it("runs runtime override activation immediately without waiting for the normal scan backlog", async () => {
        const biddingService = new FakeBiddingService();
        let releaseBlocker!: () => void;
        const blockerStarted = new Promise<void>((resolve) => {
            biddingService.activeOffersImpl = async (job: BidderJob) => {
                if (job.id === "blocker") {
                    resolve();
                    await new Promise<void>((blockerResolve) => {
                        releaseBlocker = blockerResolve;
                    });
                    return [];
                }

                if (
                    job.id === "target" &&
                    biddingService.placedAmounts.includes(4n)
                ) {
                    return [
                        {
                            id: "0xmine",
                            price: 4n,
                            maker: "0xmaker",
                            protocolAddress: "0xprotocol",
                            offerScope: "item",
                        },
                    ];
                }

                return [];
            };
        });

        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
            maxConcurrentJobs: 1,
        });

        bidder.addJob(
            makeJob("blocker", "terraforms", { type: BIDDER_TARGET_TYPE.Token, tokenId: "1" }),
        );
        bidder.addJob(
            makeJob(
                "target",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "2" },
                undefined,
                { floor: 1n, ceiling: 2n, delta: 1n },
            ),
        );

        const scanPromise = bidder.scanOnce();
        await blockerStarted;

        const activationPromise = bidder.activateJob("target", {
            floor: 4n,
            ceiling: 4n,
            ttlMs: 100000,
            reason: "intent signal",
        });

        await Promise.race([
            activationPromise,
            new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error("Activation timed out")),
                    1000,
                ),
            ),
        ]);

        assert.deepEqual(biddingService.placedAmounts, [4n]);

        releaseBlocker();
        await scanPromise;
    });

    it("runs command refresh immediately without waiting for the normal scan backlog and uses fresh WETH balance", async () => {
        const biddingService = new FakeBiddingService();
        let releaseBlocker!: () => void;
        const blockerStarted = new Promise<void>((resolve) => {
            biddingService.activeOffersImpl = async (job: BidderJob) => {
                if (job.id === "blocker") {
                    resolve();
                    await new Promise<void>((blockerResolve) => {
                        releaseBlocker = blockerResolve;
                    });
                    return [];
                }

                if (
                    job.id === "target" &&
                    biddingService.placedAmounts.includes(4n)
                ) {
                    return [
                        {
                            id: "0xmine",
                            price: 4n,
                            maker: "0xmaker",
                            protocolAddress: "0xprotocol",
                            offerScope: "item",
                        },
                    ];
                }

                return [];
            };
        });
        const makerWethBalanceService = new FakeMakerWethBalanceService(4n);

        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            {
                dryRun: false,
                maxConcurrentJobs: 1,
            },
            undefined,
            makerWethBalanceService as any,
        );

        bidder.addJob(
            makeJob("blocker", "terraforms", { type: BIDDER_TARGET_TYPE.Token, tokenId: "1" }),
        );
        bidder.addJob(
            makeJob(
                "target",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "2" },
                undefined,
                { floor: 7n, ceiling: 10n, delta: 1n },
            ),
        );

        const scanPromise = bidder.scanOnce();
        await blockerStarted;

        const commandRefreshPromise = bidder.refreshJobForCommand("target");

        await Promise.race([
            commandRefreshPromise,
            new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error("Command refresh timed out")),
                    1000,
                ),
            ),
        ]);

        assert.deepEqual(biddingService.placedAmounts, [4n]);
        assert.equal(makerWethBalanceService.calls, 2);

        releaseBlocker();
        await scanPromise;
    });

    it("runs runtime override activation immediately after the same job finishes its current execution", async () => {
        const biddingService = new FakeBiddingService();
        let firstRun = true;
        let releaseFirstRun!: () => void;
        const firstRunStarted = new Promise<void>((resolve) => {
            biddingService.activeOffersImpl = async (job: BidderJob) => {
                if (job.id !== "target") {
                    return [];
                }

                if (firstRun) {
                    firstRun = false;
                    resolve();
                    await new Promise<void>((blockerResolve) => {
                        releaseFirstRun = blockerResolve;
                    });
                }

                return [];
            };
        });

        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
            maxConcurrentJobs: 1,
        });

        bidder.addJob(
            makeJob(
                "target",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "2" },
                undefined,
                { floor: 1n, ceiling: 2n, delta: 1n },
            ),
        );

        const normalRefreshPromise = bidder.refreshJob("target");
        await firstRunStarted;

        const activationPromise = bidder.activateJob("target", {
            floor: 4n,
            ceiling: 4n,
            ttlMs: 100000,
            reason: "intent signal",
        });

        assert.deepEqual(biddingService.placedAmounts, []);

        releaseFirstRun();
        await activationPromise;
        await normalRefreshPromise;

        assert.deepEqual(biddingService.placedAmounts, [4n, 4n]);
    });

    it("clamps the effective floor to the cached WETH balance when balance is below the configured floor", async () => {
        const biddingService = new FakeBiddingService();
        const makerWethBalanceService = new FakeMakerWethBalanceService(5n);
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            { dryRun: false },
            undefined,
            makerWethBalanceService as any,
        );

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                undefined,
                { floor: 10n, ceiling: 20n, delta: 1n },
            ),
        );

        await (bidder as any).refreshCachedMakerWethBalance();
        await bidder.refreshJob("token-hit");

        assert.equal(makerWethBalanceService.calls, 1);
        assert.deepEqual(biddingService.placedAmounts, [5n]);
    });

    it("persists the runtime bid decision when a new offer is placed", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [
            { id: "0xother", price: 25n, maker: "0xother", offerScope: "item" },
        ];
        const persistedStates: Array<{
            jobRevision: number;
            activeOrderId: string | null;
            activeOrderPlacedAt: string | null;
            activeOrderVerifiedAt: string | null;
            currentPriceWei: string | null;
            bidPosition: TradingBiddingJobRuntimeBidPosition | null;
            bidConstraints: TradingBiddingJobRuntimeConstraint[];
            competitorPriceWei: string | null;
        }> = [];
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            {
                dryRun: false,
            },
            undefined,
            undefined,
            {
                persistJobRuntimeState: (snapshot) => {
                    persistedStates.push({
                        jobRevision: snapshot.jobRevision,
                        activeOrderId: snapshot.activeOrderId,
                        activeOrderPlacedAt: snapshot.activeOrderPlacedAt,
                        activeOrderVerifiedAt: snapshot.activeOrderVerifiedAt,
                        currentPriceWei: snapshot.currentPriceWei,
                        bidPosition: snapshot.bidPosition,
                        bidConstraints: snapshot.bidConstraints,
                        competitorPriceWei: snapshot.competitorPriceWei,
                    });
                },
                recordJobOfferCancellation: () => undefined,
            },
        );

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                undefined,
                { floor: 1n, ceiling: 20n, delta: 1n },
            ),
        );

        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, [20n]);
        const latestState = persistedStates.at(-1);
        assert.equal(typeof latestState?.activeOrderVerifiedAt, "string");
        assert.deepEqual(
            latestState
                ? { ...latestState, activeOrderVerifiedAt: null }
                : null,
            {
                jobRevision: 1,
                activeOrderId: "0xhash",
                activeOrderPlacedAt: "2026-05-17T00:00:00Z",
                activeOrderVerifiedAt: null,
                currentPriceWei: "20",
                bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
                bidConstraints: [
                    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling,
                ],
                competitorPriceWei: "25",
            },
        );
    });

    it("continues bid refresh when runtime persistence fails", async () => {
        const biddingService = new FakeBiddingService();
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            {
                dryRun: false,
            },
            undefined,
            undefined,
            {
                persistJobRuntimeState: () => {
                    throw new Error("runtime persistence unavailable");
                },
                recordJobOfferCancellation: () => undefined,
            },
        );
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            undefined,
            { floor: 1n, ceiling: 20n, delta: 1n },
        );
        bidder.addJob(job);

        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, [1n]);
        assert.equal(job.state.activeOrderId, "0xhash");
    });

    it("surfaces placed-offer runtime persistence failures for command refresh", async () => {
        const biddingService = new FakeBiddingService();
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            {
                dryRun: false,
            },
            undefined,
            undefined,
            {
                persistJobRuntimeState: () => {
                    throw new Error("runtime persistence unavailable");
                },
                recordJobOfferCancellation: () => undefined,
            },
        );
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            undefined,
            { floor: 1n, ceiling: 20n, delta: 1n },
        );
        bidder.addJob(job);

        await assert.rejects(
            () => bidder.refreshJobForCommand("token-hit"),
            /runtime persistence unavailable/,
        );

        assert.deepEqual(biddingService.placedAmounts, [1n]);
        assert.equal(job.state.activeOrderId, "0xhash");
    });

    it("keeps normal bid refresh best-effort when placement fails", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.placeError = new Error("opensea placement unavailable");
        const persistedErrors: Array<string | null> = [];
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            {
                dryRun: false,
            },
            undefined,
            undefined,
            {
                persistJobRuntimeState: (snapshot) => {
                    persistedErrors.push(snapshot.lastError);
                },
                recordJobOfferCancellation: () => undefined,
            },
        );
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            undefined,
            { floor: 1n, ceiling: 20n, delta: 1n },
        );
        bidder.addJob(job);

        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, []);
        assert.equal(job.state.activeOrderId, undefined);
        assert.deepEqual(persistedErrors, ["opensea placement unavailable"]);
    });

    it("optimizes a winning bid down to the minimum winning price and cancels the old bid", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [
            { id: "0xmine", price: 10n, maker: "0xMaker", offerScope: "item" },
            { id: "0xother", price: 6n, maker: "0xother", offerScope: "item" },
        ];
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
        });

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                undefined,
                { floor: 1n, ceiling: 20n, delta: 1n },
            ),
        );

        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, [7n]);
        assert.deepEqual(biddingService.canceledOrderIds, ["0xmine"]);
    });

    it("refreshes a matching maker bid when its expiration is within the poll window", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.placedExpirationTime =
            Math.floor(Date.now() / 1000) + 3600;
        biddingService.activeOffers = [
            {
                id: "0xmy-expiring-order",
                price: 6n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol",
                offerScope: "item",
                expirationTime: Math.floor((Date.now() + 1000) / 1000),
            },
            { id: "0xother", price: 5n, maker: "0xother", offerScope: "item" },
        ];
        const persistedStates: Array<{
            jobRevision: number;
            activeOrderId: string | null;
            currentPriceWei: string | null;
        }> = [];
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            5000,
            {
                dryRun: false,
            },
            undefined,
            undefined,
            {
                persistJobRuntimeState: (snapshot) => {
                    persistedStates.push({
                        jobRevision: snapshot.jobRevision,
                        activeOrderId: snapshot.activeOrderId,
                        currentPriceWei: snapshot.currentPriceWei,
                    });
                },
                recordJobOfferCancellation: () => undefined,
            },
        );
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            undefined,
            { floor: 1n, ceiling: 20n, delta: 1n },
        );

        bidder.addJob(job);

        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, [6n]);
        assert.deepEqual(biddingService.canceledOrderIds, [
            "0xmy-expiring-order",
        ]);
        assert.equal(job.state.activeOrderId, "0xhash");
        assert.ok(job.state.activeExpirationTimeMs !== undefined);
        assert.deepEqual(persistedStates.at(-1), {
            jobRevision: 1,
            activeOrderId: "0xhash",
            currentPriceWei: "6",
        });
    });

    it("preserves a known expiration from state when market responses omit it for the same order", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [
            {
                id: "0xmine",
                price: 6n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol",
                offerScope: "item",
            },
            { id: "0xother", price: 5n, maker: "0xother", offerScope: "item" },
        ];
        const bidder = new Bidder(biddingService as any, "0xmaker", 5000, {
            dryRun: false,
        });
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            6n,
        );
        const knownExpirationTimeMs = Date.now() + 60000;

        job.state.activeOrderId = "0xmine";
        job.state.activeProtocolAddress = "0xprotocol";
        job.state.activeExpirationTimeMs = knownExpirationTimeMs;
        bidder.addJob(job);

        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, []);
        assert.equal(job.state.activeExpirationTimeMs, knownExpirationTimeMs);
    });

    it("steps a winning bid down to the effective ceiling even when that moves the job into losing range", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [
            { id: "0xmine", price: 10n, maker: "0xmaker", offerScope: "item" },
            { id: "0xother", price: 8n, maker: "0xother", offerScope: "item" },
        ];
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
        });

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                undefined,
                { floor: 1n, ceiling: 7n, delta: 1n },
            ),
        );

        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, [7n]);
        assert.deepEqual(biddingService.canceledOrderIds, ["0xmine"]);
    });

    it("corrects a losing bid up to the max affordable amount and cancels the old bid", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [
            { id: "0xother", price: 8n, maker: "0xother", offerScope: "item" },
            { id: "0xmine", price: 5n, maker: "0xmaker", offerScope: "item" },
        ];
        const makerWethBalanceService = new FakeMakerWethBalanceService(7n);
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            { dryRun: false },
            undefined,
            makerWethBalanceService as any,
        );

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                undefined,
                { floor: 1n, ceiling: 20n, delta: 1n },
            ),
        );

        await (bidder as any).refreshCachedMakerWethBalance();
        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, [7n]);
        assert.deepEqual(biddingService.canceledOrderIds, ["0xmine"]);
    });

    it("keeps the highest maker bid, syncs job state to it, and cancels lower redundant maker bids", async () => {
        const biddingService = new FakeBiddingService();
        const futureExpirationTime = Math.floor(Date.now() / 1000) + 3600;
        biddingService.activeOffers = [
            {
                id: "0xmine-high",
                price: 6n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol-high",
                offerScope: "item",
                expirationTime: futureExpirationTime,
            },
            { id: "0xother", price: 5n, maker: "0xother", offerScope: "item" },
            {
                id: "0xmine-low",
                price: 4n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol-low",
                offerScope: "item",
                expirationTime: futureExpirationTime,
            },
        ];
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
        });
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            4n,
        );
        job.state.activeOrderId = "0xmine-low";
        job.state.activeProtocolAddress = "0xprotocol-low";
        job.state.activeExpirationTimeMs = futureExpirationTime * 1000;
        bidder.addJob(job);

        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, []);
        assert.deepEqual(biddingService.canceledOrderIds, ["0xmine-low"]);
        assert.equal(job.state.activeOrderId, "0xmine-high");
        assert.equal(job.state.activeProtocolAddress, "0xprotocol-high");
        assert.equal(job.state.currentPrice, 6n);
    });

    it("persists the bot-owned losing decision when a maintained bid is capped below the competitor", async () => {
        const biddingService = new FakeBiddingService();
        const futureExpirationTime = Math.floor(Date.now() / 1000) + 3600;
        biddingService.activeOffers = [
            {
                id: "0xmine",
                price: 15n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol",
                offerScope: "item",
                expirationTime: futureExpirationTime,
            },
            {
                id: "0xother",
                price: 250n,
                maker: "0xother",
                offerScope: "item",
            },
        ];
        const persistedStates: Array<{
            bidPosition: unknown;
            bidConstraints: unknown[];
            competitorPriceWei: string | null;
        }> = [];
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            { dryRun: false },
            undefined,
            undefined,
            {
                persistJobRuntimeState: (snapshot) => {
                    persistedStates.push({
                        bidPosition: snapshot.bidPosition,
                        bidConstraints: snapshot.bidConstraints,
                        competitorPriceWei: snapshot.competitorPriceWei,
                    });
                },
                recordJobOfferCancellation: () => undefined,
            },
        );
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "6236" },
            undefined,
            { floor: 15n, ceiling: 15n, delta: 1n },
        );
        job.state.activeOrderId = "0xmine";
        bidder.addJob(job);

        await bidder.refreshJob("token-hit");

        assert.deepEqual(persistedStates.at(-1), {
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "250",
        });
    });

    it("reuses an existing lower maker bid at the target price and cancels the higher stale bid", async () => {
        const biddingService = new FakeBiddingService();
        const futureExpirationTime = Math.floor(Date.now() / 1000) + 3600;
        biddingService.activeOffers = [
            {
                id: "0xmine-high",
                price: 6n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol-high",
                offerScope: "item",
                expirationTime: futureExpirationTime,
            },
            {
                id: "0xmine-target",
                price: 4n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol-target",
                offerScope: "item",
                expirationTime: futureExpirationTime,
            },
            { id: "0xother", price: 3n, maker: "0xother", offerScope: "item" },
        ];
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
        });
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            6n,
        );
        job.state.activeOrderId = "0xmine-high";
        job.state.activeProtocolAddress = "0xprotocol-high";
        job.state.activeExpirationTimeMs = futureExpirationTime * 1000;
        bidder.addJob(job);

        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, []);
        assert.deepEqual(biddingService.canceledOrderIds, ["0xmine-high"]);
        assert.equal(job.state.activeOrderId, "0xmine-target");
        assert.equal(job.state.activeProtocolAddress, "0xprotocol-target");
        assert.equal(job.state.currentPrice, 4n);
    });

    it("token jobs do not treat maker trait offers from other jobs as managed bids or cancel them", async () => {
        const biddingService = new FakeBiddingService();
        const futureExpirationTime = Math.floor(Date.now() / 1000) + 3600;
        biddingService.activeOffers = [
            { id: "0xother", price: 7n, maker: "0xother", offerScope: "trait" },
            {
                id: "0xmine-token",
                price: 5n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol-token",
                offerScope: "item",
                expirationTime: futureExpirationTime,
            },
            {
                id: "0xmine-trait",
                price: 3n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol-trait",
                offerScope: "trait",
                rawOrder: {
                    criteria: {
                        traits: [
                            { type: "Mode", value: "Terrain" },
                            { type: "Zone", value: "Mt Zuka" },
                        ],
                    },
                },
            },
        ];
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
        });
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            undefined,
            { floor: 1n, ceiling: 5n, delta: 1n },
        );
        job.state.activeOrderId = "0xmine-token";
        job.state.activeProtocolAddress = "0xprotocol-token";
        job.state.activeExpirationTimeMs = futureExpirationTime * 1000;
        bidder.addJob(job);

        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, []);
        assert.deepEqual(biddingService.canceledOrderIds, []);
        assert.equal(job.state.activeOrderId, "0xmine-token");
        assert.equal(job.state.activeProtocolAddress, "0xprotocol-token");
        assert.equal(job.state.currentPrice, 5n);
    });

    it("cancels maker bids when the effective ceiling collapses to zero", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [
            {
                id: "0xmine",
                price: 5n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol",
                offerScope: "item",
            },
            { id: "0xother", price: 4n, maker: "0xother", offerScope: "item" },
        ];
        const makerWethBalanceService = new FakeMakerWethBalanceService(0n);
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            { dryRun: false },
            undefined,
            makerWethBalanceService as any,
        );
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            5n,
        );
        job.state.activeOrderId = "0xmine";
        job.state.activeProtocolAddress = "0xprotocol";
        bidder.addJob(job);

        await (bidder as any).refreshCachedMakerWethBalance();
        await bidder.refreshJob("token-hit");

        assert.deepEqual(biddingService.placedAmounts, []);
        assert.deepEqual(biddingService.canceledOrderIds, ["0xmine"]);
        assert.equal(job.state.activeOrderId, undefined);
        assert.equal(job.state.activeProtocolAddress, undefined);
        assert.equal(job.state.currentPrice, undefined);
    });

    it("clears persisted runtime state when cancelling an unscheduled job declaration", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [
            {
                id: "0xmine",
                price: 5n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol",
                offerScope: "item",
            },
        ];
        const persistedStates: Array<{
            jobRevision: number;
            activeOrderId: string | null;
            activeProtocolAddress: string | null;
            currentPriceWei: string | null;
            bidPosition: TradingBiddingJobRuntimeBidPosition | null;
            bidConstraints: TradingBiddingJobRuntimeConstraint[];
        }> = [];
        const recordedCancellations: Array<{
            jobRevision: number;
            orderId: string;
            priceWei: string | null;
            protocolAddress: string | null;
            makerAddress: string;
            completedAt: string | null;
            cancellationError: string | null;
        }> = [];
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            { dryRun: false },
            undefined,
            undefined,
            {
                persistJobRuntimeState: (snapshot) => {
                    persistedStates.push({
                        jobRevision: snapshot.jobRevision,
                        activeOrderId: snapshot.activeOrderId,
                        activeProtocolAddress: snapshot.activeProtocolAddress,
                        currentPriceWei: snapshot.currentPriceWei,
                        bidPosition: snapshot.bidPosition,
                        bidConstraints: snapshot.bidConstraints,
                    });
                },
                recordJobOfferCancellation: (snapshot) => {
                    recordedCancellations.push({
                        jobRevision: snapshot.jobRevision,
                        orderId: snapshot.orderId,
                        priceWei: snapshot.priceWei,
                        protocolAddress: snapshot.protocolAddress,
                        makerAddress: snapshot.makerAddress,
                        completedAt: snapshot.completedAt,
                        cancellationError: snapshot.cancellationError,
                    });
                },
            },
        );
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            5n,
        );
        job.state.activeOrderId = "0xmine";
        job.state.activeProtocolAddress = "0xprotocol";
        job.state.bidPosition =
            TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Winning;
        job.state.bidConstraints = [
            TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling,
        ];

        const cancelled = await bidder.cancelActiveOffersForJob(job);

        assert.equal(cancelled, 1);
        assert.deepEqual(biddingService.canceledOrderIds, ["0xmine"]);
        assert.equal(job.state.activeOrderId, undefined);
        assert.equal(job.state.activeProtocolAddress, undefined);
        assert.equal(job.state.currentPrice, undefined);
        assert.deepEqual(persistedStates.at(-1), {
            jobRevision: 1,
            activeOrderId: null,
            activeProtocolAddress: null,
            currentPriceWei: null,
            bidPosition: null,
            bidConstraints: [],
        });
        assert.equal(recordedCancellations.at(0)?.orderId, "0xmine");
        assert.equal(recordedCancellations.at(0)?.jobRevision, 1);
        assert.equal(recordedCancellations.at(0)?.priceWei, "5");
        assert.equal(
            recordedCancellations.at(0)?.protocolAddress,
            "0xprotocol",
        );
        assert.equal(recordedCancellations.at(0)?.completedAt, null);
        const completedCancellation = recordedCancellations.at(-1);
        assert.equal(completedCancellation?.orderId, "0xmine");
        assert.equal(completedCancellation?.makerAddress, "0xmaker");
        assert.ok(completedCancellation?.completedAt);
        assert.equal(completedCancellation?.cancellationError, null);
    });

    it("cancels a tracked active order when scoped active offers omit it", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [];
        biddingService.orderLookupResult = {
            status: BIDDING_ORDER_RECOVERY_STATUS.Active,
            order: {
                id: "0xmine",
                price: 5n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol",
                offerScope: "item",
            },
        };
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
        });
        const job = makeJob(
            "token-hit",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            5n,
        );
        job.state.activeOrderId = "0xmine";
        job.state.activeProtocolAddress = "0xprotocol";

        const cancelled = await bidder.cancelActiveOffersForJob(job);

        assert.equal(cancelled, 1);
        assert.deepEqual(biddingService.canceledOrderIds, ["0xmine"]);
        assert.deepEqual(biddingService.orderLookups, [
            {
                orderHash: "0xmine",
                protocolAddress: "0xprotocol",
                collectionAddress: "0xcollection",
                tokenId: "123",
                collectionSlug: "terraforms",
            },
        ]);
        assert.equal(job.state.activeOrderId, undefined);
    });

    it("records failed cancellations without clearing tracked runtime state", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [
            {
                id: "0xmine",
                price: 5n,
                maker: "0xmaker",
                protocolAddress: "0xprotocol",
                offerScope: "item",
            },
        ];
        biddingService.cancelError = new Error("opensea cancel failed");
        const recordedCancellations: Array<{
            jobRevision: number;
            orderId: string;
            priceWei: string | null;
            completedAt: string | null;
            cancellationError: string | null;
        }> = [];
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            { dryRun: false },
            undefined,
            undefined,
            {
                persistJobRuntimeState: () => {},
                recordJobOfferCancellation: (snapshot) => {
                    recordedCancellations.push({
                        jobRevision: snapshot.jobRevision,
                        orderId: snapshot.orderId,
                        priceWei: snapshot.priceWei,
                        completedAt: snapshot.completedAt,
                        cancellationError: snapshot.cancellationError,
                    });
                },
            },
        );
        const job = makeJob(
            "token-cancel-fails",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            5n,
        );
        job.state.activeOrderId = "0xmine";
        job.state.activeProtocolAddress = "0xprotocol";

        await assert.rejects(
            () => bidder.cancelActiveOffersForJob(job),
            /opensea cancel failed/,
        );

        assert.deepEqual(biddingService.canceledOrderIds, []);
        assert.equal(job.state.activeOrderId, "0xmine");
        assert.equal(job.state.activeProtocolAddress, "0xprotocol");
        assert.deepEqual(recordedCancellations, [
            {
                jobRevision: 1,
                orderId: "0xmine",
                priceWei: "5",
                completedAt: null,
                cancellationError: null,
            },
            {
                jobRevision: 1,
                orderId: "0xmine",
                priceWei: "5",
                completedAt: null,
                cancellationError: "opensea cancel failed",
            },
        ]);
    });

    it("treats an already-absent tracked active order as cancelled", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [];
        const recordedCancellations: Array<{
            jobRevision: number;
            orderId: string;
            priceWei: string | null;
            protocolAddress: string | null;
            completedAt: string | null;
            cancellationError: string | null;
        }> = [];
        const bidder = new Bidder(
            biddingService as any,
            "0xmaker",
            1000,
            { dryRun: false },
            undefined,
            undefined,
            {
                persistJobRuntimeState: () => undefined,
                recordJobOfferCancellation: (snapshot) => {
                    recordedCancellations.push({
                        jobRevision: snapshot.jobRevision,
                        orderId: snapshot.orderId,
                        priceWei: snapshot.priceWei,
                        protocolAddress: snapshot.protocolAddress,
                        completedAt: snapshot.completedAt,
                        cancellationError: snapshot.cancellationError,
                    });
                },
            },
        );
        const job = makeJob(
            "token-missing",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            5n,
        );
        job.state.activeOrderId = "0xmine";
        job.state.activeProtocolAddress = "0xprotocol";
        job.state.currentPrice = 5n;

        const cancelled = await bidder.cancelActiveOffersForJob(job);

        assert.equal(cancelled, 0);
        assert.deepEqual(biddingService.canceledOrderIds, []);
        assert.equal(job.state.activeOrderId, undefined);
        assert.equal(job.state.activeProtocolAddress, undefined);
        assert.deepEqual(recordedCancellations, [
            {
                jobRevision: 1,
                orderId: "0xmine",
                priceWei: "5",
                protocolAddress: "0xprotocol",
                completedAt: recordedCancellations[0]?.completedAt ?? null,
                cancellationError: null,
            },
        ]);
        assert.ok(recordedCancellations[0]?.completedAt);
    });

    it("keeps tracked active order retryable when recovery is inconclusive", async () => {
        const biddingService = new FakeBiddingService();
        biddingService.activeOffers = [];
        biddingService.orderLookupResult = {
            status: BIDDING_ORDER_RECOVERY_STATUS.Inconclusive,
            reason: BIDDING_ORDER_RECOVERY_REASON.DirectLookupFailed,
        };
        const bidder = new Bidder(biddingService as any, "0xmaker", 1000, {
            dryRun: false,
        });
        const job = makeJob(
            "token-inconclusive",
            "terraforms",
            { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            5n,
        );
        job.state.activeOrderId = "0xmine";
        job.state.activeProtocolAddress = "0xprotocol";
        job.state.currentPrice = 5n;

        await assert.rejects(
            () => bidder.cancelActiveOffersForJob(job),
            /Unable to prove tracked active order status/,
        );

        assert.deepEqual(biddingService.canceledOrderIds, []);
        assert.equal(job.state.activeOrderId, "0xmine");
        assert.equal(job.state.activeProtocolAddress, "0xprotocol");
    });

    it("refreshes only token jobs whose cached metadata matches every trait criterion", async () => {
        const tokenMetadataRepository = new FakeTokenMetadataRepository({
            "terraforms:123": [
                { type: "Biome", value: "53" },
                { type: "Chroma", value: "Flow" },
            ],
            "terraforms:456": [{ type: "Biome", value: "53" }],
            "terraforms:999": [
                { type: "Biome", value: "53" },
                { type: "Chroma", value: "Flow" },
            ],
        });
        const bidder = new Bidder(
            new FakeBiddingService() as any,
            "0xmaker",
            1000,
            { dryRun: true },
            tokenMetadataRepository,
        );
        const refreshedJobIds: string[] = [];

        bidder.addJob(
            makeJob(
                "token-hit",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
                5n,
            ),
        );
        bidder.addJob(
            makeJob(
                "token-metadata-miss",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "456" },
                5n,
            ),
        );
        bidder.addJob(
            makeJob(
                "token-no-metadata",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "789" },
                5n,
            ),
        );
        bidder.addJob(
            makeJob(
                "token-price-skip",
                "terraforms",
                { type: BIDDER_TARGET_TYPE.Token, tokenId: "999" },
                7n,
            ),
        );

        bidder.refreshJob = async (jobId: string) => {
            refreshedJobIds.push(jobId);
        };

        await bidder.refreshMatchingJobs(
            makeEvent(Type.TraitOffer, Scope.Trait, "terraforms", "", 6n, [
                { type: "Biome", value: "53" },
                { type: "Chroma", value: "Flow" },
            ]),
        );

        assert.deepEqual(refreshedJobIds, ["token-hit"]);
    });
});
