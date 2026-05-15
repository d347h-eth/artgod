import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import {
    TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
    TRADING_BOT_KIND,
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_COMMAND_STATUS,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type ChainRecord,
    type CollectionListItem,
    type PersistedBiddingJobRecord,
    type PersistedBiddingPriceTierRecord,
    type TradingJobCommandRecord,
} from "@artgod/shared/types";
import {
    ApplyBiddingPriceTierReapplyUseCase,
} from "./apply-bidding-price-tier-reapply.js";
import {
    buildBiddingPriceTierReapplyPlan,
} from "./bidding-price-tier-reapply.js";
import {
    PreviewBiddingPriceTierReapplyUseCase,
} from "./preview-bidding-price-tier-reapply.js";
import { TradingValidationError } from "./types.js";

const CHAIN: ChainRecord = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};

const COLLECTION: CollectionListItem = {
    chainId: 1,
    collectionId: 7,
    slug: "terraforms",
    address: "0x1111111111111111111111111111111111111111",
    standard: "erc721",
    status: "live",
    deploymentBlock: 1,
    bootstrapAnchorBlock: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
};

describe("bidding price tier reapply", () => {
    it("builds a changed reapply plan only for jobs linked to the selected tier", () => {
        const plan = buildBiddingPriceTierReapplyPlan({
            tierId: "tier-base",
            tiers: [priceTier()],
            jobs: [
                biddingJob({ jobId: "job-tier", priceTierId: "tier-base" }),
                biddingJob({ jobId: "job-manual", priceTierId: null }),
            ],
        });

        assert.equal(plan.tier.tierId, "tier-base");
        assert.deepEqual(
            plan.jobs.map((job) => ({
                jobId: job.job.jobId,
                changed: job.changed,
                before: job.before,
                after: job.after,
                afterWei: job.afterWei,
            })),
            [
                {
                    jobId: "job-tier",
                    changed: true,
                    before: {
                        floorEth: "0.12",
                        ceilingEth: "0.15",
                        deltaEth: "0.01",
                        pricingSource: null,
                    },
                    after: {
                        floorEth: "0.13",
                        ceilingEth: "0.17",
                        deltaEth: "0.02",
                        pricingSource: {
                            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                            tierId: "tier-base",
                            tierName: "Base",
                            resolvedAt: plan.tier.resolvedAt,
                            resolvedFloorWei: "130000000000000000",
                            resolvedCeilingWei: "170000000000000000",
                            deltaWei: "20000000000000000",
                        },
                    },
                    afterWei: {
                        floorWei: "130000000000000000",
                        ceilingWei: "170000000000000000",
                        deltaWei: "20000000000000000",
                        priceTierId: "tier-base",
                        pricingSource: {
                            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                            tierId: "tier-base",
                            tierName: "Base",
                            resolvedAt: plan.tier.resolvedAt,
                            resolvedFloorWei: "130000000000000000",
                            resolvedCeilingWei: "170000000000000000",
                            deltaWei: "20000000000000000",
                        },
                    },
                },
            ],
        );
    });

    it("rejects previews for unknown tiers", () => {
        const preview = new PreviewBiddingPriceTierReapplyUseCase(
            1,
            { resolveChainRef: () => CHAIN },
            { resolveCollectionRef: () => COLLECTION },
            { listCollectionJobs: () => [] },
            { listCollectionPriceTiers: () => [priceTier()] },
        );

        assert.throws(
            () =>
                preview.previewBiddingPriceTierReapply({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    tierId: "missing",
                }),
            ReadModelNotFoundError,
        );
        assert.throws(
            () =>
                buildBiddingPriceTierReapplyPlan({
                    tierId: "missing",
                    jobs: [],
                    tiers: [priceTier()],
                }),
            /price tier missing was not found/,
        );
    });

    it("applies selected changed jobs and publishes durable command wake-ups", () => {
        const commands = [command({ commandId: 1, jobId: "job-tier" })];
        const updates: unknown[] = [];
        let publishedCommands: TradingJobCommandRecord[] = [];
        const useCase = new ApplyBiddingPriceTierReapplyUseCase(
            1,
            { resolveChainRef: () => CHAIN },
            { resolveCollectionRef: () => COLLECTION },
            {
                listCollectionJobs: () => [
                    biddingJob({ jobId: "job-tier", priceTierId: "tier-base" }),
                ],
                updateJobsPricingById: (inputs) => {
                    updates.push(...inputs);
                    return {
                        jobs: [
                            biddingJob({
                                jobId: "job-tier",
                                priceTierId: "tier-base",
                                floorWei: "130000000000000000",
                                ceilingWei: "170000000000000000",
                                deltaWei: "20000000000000000",
                            }),
                        ],
                        commands,
                    };
                },
            },
            { listCollectionPriceTiers: () => [priceTier()] },
            {
                publishBiddingJobCommandsChanged: (nextCommands) => {
                    publishedCommands = nextCommands;
                },
            },
        );

        const result = useCase.applyBiddingPriceTierReapply({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            tierId: "tier-base",
            jobIds: ["job-tier"],
        });

        assert.equal(result.jobs[0]?.config.floorEth, "0.13");
        assert.equal(result.preview[0]?.changed, true);
        assert.equal(updates.length, 1);
        assert.equal(
            (updates[0] as { floorWei: string }).floorWei,
            "130000000000000000",
        );
        assert.deepEqual(publishedCommands, commands);
    });

    it("rejects empty or non-tier-backed apply selections", () => {
        const useCase = new ApplyBiddingPriceTierReapplyUseCase(
            1,
            { resolveChainRef: () => CHAIN },
            { resolveCollectionRef: () => COLLECTION },
            {
                listCollectionJobs: () => [
                    biddingJob({ jobId: "job-tier", priceTierId: "tier-base" }),
                ],
                updateJobsPricingById: () => {
                    throw new Error("Unexpected update");
                },
            },
            { listCollectionPriceTiers: () => [priceTier()] },
            { publishBiddingJobCommandsChanged: () => undefined },
        );

        assert.throws(
            () =>
                useCase.applyBiddingPriceTierReapply({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    tierId: "tier-base",
                    jobIds: [],
                }),
            /jobIds is required/,
        );
        assert.throws(
            () =>
                useCase.applyBiddingPriceTierReapply({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    tierId: "tier-base",
                    jobIds: ["missing"],
                }),
            TradingValidationError,
        );
    });
});

function priceTier(): PersistedBiddingPriceTierRecord {
    return {
        tierId: "tier-base",
        chainId: 1,
        collectionId: COLLECTION.collectionId,
        name: "Base",
        status: TRADING_JOB_STATUS.Enabled,
        sortOrder: 1,
        parentTierId: null,
        floorConfig: {
            kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
            valueEth: "0.13",
        },
        ceilingConfig: {
            kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
            valueEth: "0.17",
        },
        deltaWei: "20000000000000000",
        resolvedFloorWei: null,
        resolvedCeilingWei: null,
        resolvedAt: null,
        lastError: null,
        revision: 1,
        createdAt: "2026-05-15T00:00:00Z",
        updatedAt: "2026-05-15T00:00:00Z",
        archivedAt: null,
    };
}

function biddingJob(
    overrides: Partial<PersistedBiddingJobRecord>,
): PersistedBiddingJobRecord {
    return {
        jobId: "job-tier",
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: 1,
        collectionId: COLLECTION.collectionId,
        collectionSlug: COLLECTION.slug,
        collectionOpenseaSlug: COLLECTION.slug,
        collectionAddress: COLLECTION.address,
        status: TRADING_JOB_STATUS.Enabled,
        targetKind: TRADING_JOB_TARGET_KIND.Token,
        tokenId: "1",
        quantity: null,
        targetTraits: [],
        competitorTraits: [],
        floorWei: "120000000000000000",
        ceilingWei: "150000000000000000",
        deltaWei: "10000000000000000",
        priceTierId: "tier-base",
        pricingSource: null,
        revision: 1,
        createdAt: "2026-05-15T00:00:00Z",
        updatedAt: "2026-05-15T00:00:00Z",
        archivedAt: null,
        runtime: null,
        ...overrides,
    };
}

function command(
    overrides: Partial<TradingJobCommandRecord>,
): TradingJobCommandRecord {
    return {
        commandId: 1,
        jobId: "job-tier",
        botKind: TRADING_BOT_KIND.Bidding,
        commandKind: TRADING_JOB_COMMAND_KIND.JobUpdated,
        status: TRADING_JOB_COMMAND_STATUS.Pending,
        requestedRevision: 1,
        payload: {},
        attempts: 0,
        lastError: null,
        createdAt: "2026-05-15T00:00:00Z",
        claimedAt: null,
        completedAt: null,
        ...overrides,
    };
}
