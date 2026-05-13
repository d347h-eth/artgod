import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type ChainRecord,
    type CollectionListItem,
    type PersistedCollectionBiddingJobRecord,
    type TradingJobCommandRecord,
} from "@artgod/shared/types";
import { UpsertTraitBiddingJobUseCase } from "./upsert-trait-bidding-job.js";

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

describe("UpsertTraitBiddingJobUseCase", () => {
    it("normalizes a clean trait selection and publishes durable commands", () => {
        const commands: TradingJobCommandRecord[] = [
            {
                commandId: 1,
                jobId: "job-trait",
                botKind: TRADING_BOT_KIND.Bidding,
                commandKind: TRADING_JOB_COMMAND_KIND.JobCreated,
                status: "pending",
                requestedRevision: 1,
                payload: {},
                attempts: 0,
                lastError: null,
                createdAt: "2026-01-01T00:00:00Z",
                claimedAt: null,
                completedAt: null,
            },
        ];
        const persistedInputs: {
            floorWei: string;
            ceilingWei: string;
            deltaWei: string;
            targetTraits: { type: string; value: string }[];
        }[] = [];
        let publishedCommands: TradingJobCommandRecord[] = [];
        const useCase = new UpsertTraitBiddingJobUseCase(
            1,
            {
                resolveChainRef: () => CHAIN,
            },
            {
                resolveCollectionRef: () => COLLECTION,
            },
            {
                upsertCollectionJob: (input) => {
                    persistedInputs.push(input);
                    return {
                        job: buildPersistedTraitJob({
                            floorWei: input.floorWei,
                            ceilingWei: input.ceilingWei,
                            deltaWei: input.deltaWei,
                            targetTraits: input.targetTraits,
                        }),
                        commands,
                    };
                },
            },
            {
                listCollectionPriceTiers: () => [],
            },
            {
                publishBiddingJobCommandsChanged: (nextCommands) => {
                    publishedCommands = nextCommands;
                },
            },
        );

        const result = useCase.upsertTraitBiddingJob({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            status: TRADING_JOB_STATUS.Enabled,
            floorEth: "0.1",
            ceilingEth: "0.2",
            deltaEth: "0.001",
            targetTraits: [
                { type: "Mode", value: "Terrain" },
                { type: "Biome", value: "42" },
            ],
        });

        const persistedInput = persistedInputs[0];
        assert.ok(persistedInput);
        assert.equal(persistedInput.floorWei, "100000000000000000");
        assert.equal(persistedInput.ceilingWei, "200000000000000000");
        assert.equal(persistedInput.deltaWei, "1000000000000000");
        assert.deepEqual(persistedInput.targetTraits, [
            { type: "Biome", value: "42" },
            { type: "Mode", value: "Terrain" },
        ]);
        assert.equal(result.job.target.type, "collection");
        assert.deepEqual(result.job.target.targetTraits, persistedInput.targetTraits);
        assert.deepEqual(publishedCommands, commands);
    });
});

function buildPersistedTraitJob(input: {
    floorWei: string;
    ceilingWei: string;
    deltaWei: string;
    targetTraits: { type: string; value: string }[];
}): PersistedCollectionBiddingJobRecord {
    return {
        jobId: "job-trait",
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: 1,
        collectionId: COLLECTION.collectionId,
        collectionSlug: COLLECTION.slug,
        collectionOpenseaSlug: COLLECTION.slug,
        collectionAddress: COLLECTION.address,
        status: TRADING_JOB_STATUS.Enabled,
        floorWei: input.floorWei,
        ceilingWei: input.ceilingWei,
        deltaWei: input.deltaWei,
        priceTierId: null,
        pricingSource: null,
        revision: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        archivedAt: null,
        runtime: null,
        targetKind: TRADING_JOB_TARGET_KIND.Collection,
        tokenId: null,
        quantity: 1,
        targetTraits: input.targetTraits,
        competitorTraits: [],
    };
}
