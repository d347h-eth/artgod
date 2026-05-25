import { describe, expect, it } from "vitest";
import {
    summarizeJobBacklog,
    type InspectableJobEnvelope,
} from "../src/application/queue-inspection/job-backlog-summary.js";

describe("summarizeJobBacklog", () => {
    it("summarizes maker update backlog shape by reason, scope, maker, and block", () => {
        const rows = [
            makerJob(10, {
                scope: "global",
                maker: "0xaaa",
                reason: "erc20-balance",
                blockNumber: 100,
                txHash: "0xtx1",
                logIndex: 1,
            }),
            makerJob(11, {
                scope: "global",
                maker: "0xaaa",
                reason: "erc20-balance",
                blockNumber: 101,
                txHash: "0xtx2",
                logIndex: 2,
            }),
            makerJob(12, {
                scope: "global",
                maker: "0xbbb",
                reason: "order-counter",
                blockNumber: 101,
                txHash: "0xtx3",
                logIndex: 3,
            }),
            makerJob(13, {
                scope: "token",
                maker: "0xccc",
                reason: "nft-transfer",
                collectionId: 1,
                tokenId: "42",
                blockNumber: 102,
                txHash: "0xtx4",
                logIndex: 4,
            }),
        ];

        const summary = summarizeJobBacklog(rows, { topN: 2, sampleSize: 1 });

        expect(summary.total).toBe(4);
        expect(summary.seq).toEqual({ first: 10, last: 13 });
        expect(summary.scopes).toEqual([
            { key: "global", count: 3 },
            { key: "token", count: 1 },
        ]);
        expect(summary.reasons).toEqual([
            { key: "erc20-balance", count: 2 },
            { key: "nft-transfer", count: 1 },
            { key: "order-counter", count: 1 },
        ]);
        expect(summary.blockStats).toMatchObject({
            min: 100,
            max: 102,
            unique: 3,
        });
        expect(summary.makerStats).toMatchObject({
            unique: 3,
            top: [
                { key: "0xaaa", count: 2 },
                { key: "0xbbb", count: 1 },
            ],
        });
        expect(summary.byReason[0]).toMatchObject({
            reason: "erc20-balance",
            count: 2,
            uniqueMakers: 1,
            uniqueBlocks: 2,
            minBlock: 100,
            maxBlock: 101,
        });
        expect(summary.samples.first.map((row) => row.seq)).toEqual([10]);
        expect(summary.samples.last.map((row) => row.seq)).toEqual([13]);
    });
});

function makerJob(
    seq: number,
    payload: Record<string, unknown>,
): InspectableJobEnvelope {
    return {
        seq,
        time: `2026-05-25T00:00:${seq}.000Z`,
        subject: "artgod.jobs.order-updates-by-maker",
        jobId: `job-${seq}`,
        kind: "orders.update-by-maker",
        queue: "order-updates-by-maker",
        attempt: 0,
        scheduledAt: seq,
        chainId: 1,
        collectionId:
            typeof payload.collectionId === "number"
                ? payload.collectionId
                : null,
        traceId: null,
        payload,
    };
}
