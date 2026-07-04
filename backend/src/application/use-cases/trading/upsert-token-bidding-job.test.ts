import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_JOB_STATUS,
    type ChainRecord,
    type CollectionListItem,
} from "@artgod/shared/types";
import { UpsertTokenBiddingJobUseCase } from "./upsert-token-bidding-job.js";

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

describe("UpsertTokenBiddingJobUseCase", () => {
    it("rejects synthetic token targets before persisting bidding jobs", async () => {
        const useCase = new UpsertTokenBiddingJobUseCase(
            1,
            {
                resolveChainRef: () => CHAIN,
            },
            {
                resolveCollectionRef: () => COLLECTION,
                getCollectionTokenDetail: () => ({
                    tokenId: "unminted-tile-921",
                    marketplaceBiddingSupported: false,
                }),
            },
            {
                upsertTokenJob: () => {
                    throw new Error("Unexpected token job mutation");
                },
            },
            {
                listCollectionPriceTiers: () => [],
            },
            {
                publishBiddingJobCommandsChanged: () => {
                    throw new Error("Unexpected command publish");
                },
            },
        );

        await assert.rejects(
            useCase.upsertTokenBiddingJob({
                chainRef: "ethereum",
                collectionRef: "terraforms",
                tokenRef: "unminted-tile-921",
                status: TRADING_JOB_STATUS.Enabled,
                floorEth: "0.1",
                ceilingEth: "0.2",
                deltaEth: "0.001",
            }),
            /selected token target is not available for marketplace bidding: unminted-tile-921/,
        );
    });
});
