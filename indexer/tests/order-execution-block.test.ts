import { describe, expect, it, vi } from "vitest";
import { CanonicalOrderExecutionBlock } from "../src/application/orders/execution-block.js";
import type { RpcProviderPort } from "../src/ports/rpc.js";

const TX = `0x${"12".repeat(32)}` as const;
const HASH = `0x${"34".repeat(32)}` as const;
const OTHER = `0x${"56".repeat(32)}` as const;
const BLOCK = 100;

function fixture() {
    const receipt = vi
        .fn<RpcProviderPort["getTransactionReceipt"]>()
        .mockResolvedValue({
            transactionHash: TX,
            blockHash: HASH,
            blockNumber: BLOCK,
            logs: [],
        });
    const block = vi.fn<RpcProviderPort["getBlock"]>().mockResolvedValue({
        number: BLOCK,
        hash: HASH,
        parentHash: OTHER,
        timestamp: 1000,
        transactions: [TX],
    });
    return {
        receipt,
        block,
        resolve: new CanonicalOrderExecutionBlock({
            getTransactionReceipt: receipt,
            getBlock: block,
        }),
    };
}

describe("source execution block coverage", () => {
    it("requires fresh receipt attribution and canonical block membership", async () => {
        const work = fixture();
        await expect(work.resolve.resolve(TX)).resolves.toBe(BLOCK);
        expect(work.receipt).toHaveBeenCalledExactlyOnceWith(TX, {
            fresh: true,
        });
        expect(work.block).toHaveBeenCalledExactlyOnceWith(BLOCK, {
            fresh: true,
        });
    });
    it.each([
        { transactionHash: OTHER, blockNumber: BLOCK, blockHash: HASH },
        { transactionHash: TX, blockNumber: -1, blockHash: HASH },
        { transactionHash: TX, blockNumber: BLOCK, blockHash: "invalid" },
    ])("rejects unusable receipt attribution %s", async (value) => {
        const work = fixture();
        work.receipt.mockResolvedValue({ ...value, logs: [] } as Awaited<
            ReturnType<RpcProviderPort["getTransactionReceipt"]>
        >);
        await expect(work.resolve.resolve(TX)).rejects.toThrow(
            "block attribution",
        );
        expect(work.block).not.toHaveBeenCalled();
    });
    it.each([
        { number: BLOCK, hash: OTHER, transactions: [TX] },
        { number: BLOCK + 1, hash: HASH, transactions: [TX] },
        { number: BLOCK, hash: HASH, transactions: [] },
    ])("rejects changed or missing canonical inclusion %s", async (value) => {
        const work = fixture();
        work.block.mockResolvedValue({
            ...value,
            timestamp: 1000,
            parentHash: OTHER,
        });
        await expect(work.resolve.resolve(TX)).rejects.toThrow(
            "canonical block",
        );
    });
    it("propagates unavailable receipts so the queue delivery retains the obligation", async () => {
        const work = fixture();
        work.receipt.mockRejectedValue(new Error("receipt unavailable"));
        await expect(work.resolve.resolve(TX)).rejects.toThrow(
            "receipt unavailable",
        );
        expect(work.block).not.toHaveBeenCalled();
    });
});
