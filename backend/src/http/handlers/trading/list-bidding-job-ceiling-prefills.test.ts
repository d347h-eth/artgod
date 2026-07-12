import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import type { FastifyRequest } from "fastify";
import type { ChainRecord } from "@artgod/shared/types";
import {
    ListBiddingJobCeilingPrefillsHttpAdapter,
    type ListBiddingJobCeilingPrefillsRoute,
} from "./list-bidding-job-ceiling-prefills.js";

const ETHEREUM: ChainRecord = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};

describe("ListBiddingJobCeilingPrefillsHttpAdapter", () => {
    it("maps the chain route parameter into the use-case input", async () => {
        const inputs: unknown[] = [];
        const adapter = new ListBiddingJobCeilingPrefillsHttpAdapter({
            listBiddingJobCeilingPrefills: (input) => {
                inputs.push(input);
                return {
                    chain: ETHEREUM,
                    prefills: [{ collectionId: 7, maxCeilingEth: "1.25" }],
                };
            },
        });

        const output = await adapter.handle({
            params: { chain_ref: "ethereum" },
        } as FastifyRequest<ListBiddingJobCeilingPrefillsRoute>);

        assert.deepEqual(inputs, [{ chainRef: "ethereum" }]);
        assert.deepEqual(output, {
            chain: ETHEREUM,
            prefills: [{ collectionId: 7, maxCeilingEth: "1.25" }],
        });
    });
});
