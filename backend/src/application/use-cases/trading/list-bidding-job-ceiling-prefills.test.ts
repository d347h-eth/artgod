import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import type { ChainRecord } from "@artgod/shared/types";
import { ListBiddingJobCeilingPrefillsUseCase } from "./list-bidding-job-ceiling-prefills.js";

const ETHEREUM: ChainRecord = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};

describe("ListBiddingJobCeilingPrefillsUseCase", () => {
    it("resolves the chain and formats exact collection maxima in Ether units", () => {
        const calls: number[] = [];
        const useCase = new ListBiddingJobCeilingPrefillsUseCase(
            1,
            {
                resolveChainRef: (chainRef, defaultChainId) => {
                    assert.equal(chainRef, "ethereum");
                    assert.equal(defaultChainId, 1);
                    return ETHEREUM;
                },
            },
            {
                listCeilingPrefillMaxima: ({ chainId }) => {
                    calls.push(chainId);
                    return [
                        {
                            collectionId: 7,
                            maxCeilingWei: "1250000000000000000",
                        },
                        {
                            collectionId: 9,
                            maxCeilingWei: "10000000000000000000",
                        },
                    ];
                },
            },
        );

        assert.deepEqual(
            useCase.listBiddingJobCeilingPrefills({ chainRef: "ethereum" }),
            {
                chain: ETHEREUM,
                prefills: [
                    { collectionId: 7, maxCeilingEth: "1.25" },
                    { collectionId: 9, maxCeilingEth: "10" },
                ],
            },
        );
        assert.deepEqual(calls, [1]);
    });
});
