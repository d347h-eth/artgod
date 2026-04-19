import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { loadBiddingJobsFromFile } from "./bidding-jobs-file.js";

async function writeJobsFile(payload: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-bidding-jobs-"));
    const filePath = join(dir, "bidding-jobs.json");
    await writeFile(filePath, JSON.stringify(payload, null, 4), "utf8");
    return filePath;
}

describe("loadBiddingJobsFromFile", () => {
    it("loads token, collection, and competitiveTrait jobs with empty runtime state", async () => {
        const filePath = await writeJobsFile([
            {
                id: "token-job",
                network: "eth",
                collectionAddress:
                    "0x0000000000000000000000000000000000000001",
                collectionSlug: "terraforms",
                target: {
                    type: "token",
                    tokenId: "123",
                },
                config: {
                    floorEth: "0.10",
                    ceilingEth: "0.20",
                    deltaEth: "0.001",
                },
            },
            {
                id: "collection-job",
                network: "eth",
                collectionAddress:
                    "0x0000000000000000000000000000000000000002",
                collectionSlug: "terraforms",
                target: {
                    type: "collection",
                    quantity: 1,
                    traits: [
                        { type: "Biome", value: "81" },
                        { type: "Mode", value: "Terrain" },
                    ],
                },
                config: {
                    floorEth: "0.10",
                    ceilingEth: "0.20",
                    deltaEth: "0.001",
                },
            },
            {
                id: "competitive-trait-job",
                network: "eth",
                collectionAddress:
                    "0x0000000000000000000000000000000000000003",
                collectionSlug: "terraforms",
                target: {
                    type: "competitiveTrait",
                    quantity: 1,
                    targetTrait: { type: "Biome", value: "53" },
                    competitorTraits: [
                        { type: "Biome", value: "53" },
                        { type: "Mode" },
                    ],
                },
                config: {
                    floorEth: "0.10",
                    ceilingEth: "0.20",
                    deltaEth: "0.001",
                },
            },
        ]);

        const jobs = await loadBiddingJobsFromFile(filePath);

        assert.equal(jobs.length, 3);
        assert.deepEqual(jobs[0]?.state, {});
        assert.equal(jobs[0]?.config.floor, 100000000000000000n);
        assert.equal(jobs[0]?.target.type, "token");
        assert.equal(jobs[1]?.target.type, "collection");
        assert.equal(jobs[2]?.target.type, "competitiveTrait");
    });

    it("rejects duplicate job ids", async () => {
        const filePath = await writeJobsFile([
            {
                id: "duplicate",
                network: "eth",
                collectionAddress:
                    "0x0000000000000000000000000000000000000001",
                collectionSlug: "terraforms",
                target: { type: "token", tokenId: "1" },
                config: {
                    floorEth: "0.10",
                    ceilingEth: "0.20",
                    deltaEth: "0.001",
                },
            },
            {
                id: "duplicate",
                network: "eth",
                collectionAddress:
                    "0x0000000000000000000000000000000000000002",
                collectionSlug: "terraforms",
                target: { type: "token", tokenId: "2" },
                config: {
                    floorEth: "0.10",
                    ceilingEth: "0.20",
                    deltaEth: "0.001",
                },
            },
        ]);

        await assert.rejects(
            () => loadBiddingJobsFromFile(filePath),
            /Duplicate bidding job id/,
        );
    });

    it("rejects invalid ETH amount strings", async () => {
        const filePath = await writeJobsFile([
            {
                id: "invalid-config",
                network: "eth",
                collectionAddress:
                    "0x0000000000000000000000000000000000000001",
                collectionSlug: "terraforms",
                target: { type: "token", tokenId: "1" },
                config: {
                    floorEth: "not-a-number",
                    ceilingEth: "0.20",
                    deltaEth: "0.001",
                },
            },
        ]);

        await assert.rejects(
            () => loadBiddingJobsFromFile(filePath),
            /Invalid bidding job #1.*floorEth/,
        );
    });
});
