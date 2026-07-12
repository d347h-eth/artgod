import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import type { FastifyRequest } from "fastify";
import type { ChainRecord } from "@artgod/shared/types";
import {
    ListActiveBiddingJobCeilingsHttpAdapter,
    type ListActiveBiddingJobCeilingsRoute,
} from "./list-active-bidding-job-ceilings.js";

const ETHEREUM: ChainRecord = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};

describe("ListActiveBiddingJobCeilingsHttpAdapter", () => {
    it("maps the chain route parameter into the use-case input", async () => {
        const inputs: unknown[] = [];
        const adapter = new ListActiveBiddingJobCeilingsHttpAdapter({
            listActiveBiddingJobCeilings: (input) => {
                inputs.push(input);
                return {
                    chain: ETHEREUM,
                    ceilings: [{ collectionId: 7, maxCeilingEth: "1.25" }],
                };
            },
        });

        const output = await adapter.handle({
            params: { chain_ref: "ethereum" },
        } as FastifyRequest<ListActiveBiddingJobCeilingsRoute>);

        assert.deepEqual(inputs, [{ chainRef: "ethereum" }]);
        assert.deepEqual(output, {
            chain: ETHEREUM,
            ceilings: [{ collectionId: 7, maxCeilingEth: "1.25" }],
        });
    });
});
