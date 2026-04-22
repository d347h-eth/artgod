import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import type { Hash } from "viem";
import { ViemWethAllowanceApprovalService } from "./viem-weth-allowance-approval-service.js";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const OWNER = "0x00000000000000000000000000000000000000aA";
const CONDUIT = "0x1E0049783F008A0085193E00003D00CD54003c71";
const CONDUIT_CHECKSUM = "0x1E0049783F008A0085193E00003D00cd54003c71";
const TRANSACTION_POLICY = {
    fees: {
        minPriorityFeePerGasWei: 1_000_000_000n,
        priorityFeeHistoryBlockCount: 20,
        priorityFeeHistoryRewardPercentile: 70,
        baseFeeMultiplierBps: 12_500n,
        maxFeePerGasWei: 100_000_000_000n,
    },
    nonce: {
        pendingNoncePolicy: "fail" as const,
    },
};

describe("ViemWethAllowanceApprovalService", () => {
    it("skips all chain calls when configured allowance is zero", async () => {
        let readCalls = 0;
        let writeCalls = 0;
        const service = new ViemWethAllowanceApprovalService(
            {
                ...createTransactionPolicyReadDefaults(),
                async readContract() {
                    readCalls += 1;
                    return 0n;
                },
                async waitForTransactionReceipt() {
                    throw new Error("unexpected wait");
                },
            },
            {
                async writeContract() {
                    writeCalls += 1;
                    return "0x01" as Hash;
                },
            },
            WETH,
            CONDUIT,
            TRANSACTION_POLICY,
        );

        const result = await service.ensureAllowance({
            ownerAddress: OWNER,
            desiredAllowanceWei: 0n,
        });

        assert.equal(result.status, "disabled");
        assert.equal(result.currentAllowanceWei, null);
        assert.equal(readCalls, 0);
        assert.equal(writeCalls, 0);
    });

    it("does not approve when the current allowance already covers the configured allowance", async () => {
        const calls: Array<{
            functionName: string;
            args: readonly string[];
        }> = [];
        const service = new ViemWethAllowanceApprovalService(
            {
                ...createTransactionPolicyReadDefaults(),
                async readContract(args) {
                    calls.push({
                        functionName: args.functionName,
                        args: args.args,
                    });
                    return 100n;
                },
                async waitForTransactionReceipt() {
                    throw new Error("unexpected wait");
                },
            },
            {
                async writeContract() {
                    throw new Error("unexpected write");
                },
            },
            WETH,
            CONDUIT,
            TRANSACTION_POLICY,
        );

        const result = await service.ensureAllowance({
            ownerAddress: OWNER,
            desiredAllowanceWei: 50n,
        });

        assert.equal(result.status, "sufficient");
        assert.equal(result.currentAllowanceWei, 100n);
        assert.deepEqual(calls, [
            {
                functionName: "allowance",
                args: [
                    "0x00000000000000000000000000000000000000AA",
                    CONDUIT_CHECKSUM,
                ],
            },
        ]);
    });

    it("approves the exact configured allowance and waits for confirmation when allowance is low", async () => {
        const writes: Array<{
            functionName: string;
            args: readonly [string, bigint];
            maxFeePerGas: bigint;
            maxPriorityFeePerGas: bigint;
        }> = [];
        const waits: Hash[] = [];
        const progress: string[] = [];
        const gasEstimates: Array<{
            account: string;
            address: string;
            functionName: string;
            args: readonly [string, bigint];
        }> = [];
        const feeReads: string[] = [];
        const blockReads: string[] = [];
        const transactionCounts: Array<{
            address: string;
            blockTag: string;
        }> = [];
        const transactionLookups: Hash[] = [];
        const service = new ViemWethAllowanceApprovalService(
            {
                async readContract() {
                    return 10n;
                },
                async waitForTransactionReceipt(args) {
                    waits.push(args.hash);
                    return {};
                },
                async estimateContractGas(args) {
                    gasEstimates.push({
                        account: args.account,
                        address: args.address,
                        functionName: args.functionName,
                        args: args.args,
                    });
                    return 50_000n;
                },
                async estimateFeesPerGas() {
                    feeReads.push("estimateFeesPerGas");
                    return {
                        maxFeePerGas: 42_000_000_000n,
                        maxPriorityFeePerGas: 0n,
                    };
                },
                async getBlock(args) {
                    blockReads.push(args.blockTag);
                    return {
                        number: 123n,
                        baseFeePerGas: 40_000_000_000n,
                    };
                },
                async getTransactionCount(args) {
                    transactionCounts.push({
                        address: args.address,
                        blockTag: args.blockTag,
                    });
                    return 7;
                },
                async getTransaction(args) {
                    transactionLookups.push(args.hash);
                    return {
                        type: "eip1559",
                        nonce: 7,
                        gas: 50_000n,
                        maxFeePerGas: 51_000_000_000n,
                        maxPriorityFeePerGas: 1_000_000_000n,
                        blockHash: null,
                        blockNumber: null,
                    };
                },
            },
            {
                async writeContract(args) {
                    writes.push({
                        functionName: args.functionName,
                        args: args.args,
                        maxFeePerGas: args.maxFeePerGas,
                        maxPriorityFeePerGas: args.maxPriorityFeePerGas,
                    });
                    return "0x1234" as Hash;
                },
            },
            WETH,
            CONDUIT,
            TRANSACTION_POLICY,
        );

        const result = await service.ensureAllowance({
            ownerAddress: OWNER,
            desiredAllowanceWei: 75n,
            onProgress(detail) {
                progress.push(detail);
            },
        });

        assert.equal(result.status, "approved");
        assert.equal(result.currentAllowanceWei, 10n);
        assert.equal(result.transactionHash, "0x1234");
        assert.deepEqual(writes, [
            {
                functionName: "approve",
                args: [CONDUIT_CHECKSUM, 75n],
                maxFeePerGas: 51_000_000_000n,
                maxPriorityFeePerGas: 1_000_000_000n,
            },
        ]);
        assert.deepEqual(waits, ["0x1234"]);
        assert.deepEqual(gasEstimates, [
            {
                account: "0x00000000000000000000000000000000000000AA",
                address: WETH,
                functionName: "approve",
                args: [CONDUIT_CHECKSUM, 75n],
            },
        ]);
        assert.deepEqual(feeReads, ["estimateFeesPerGas"]);
        assert.deepEqual(blockReads, ["latest"]);
        assert.deepEqual(transactionCounts, [
            {
                address: "0x00000000000000000000000000000000000000AA",
                blockTag: "latest",
            },
            {
                address: "0x00000000000000000000000000000000000000AA",
                blockTag: "pending",
            },
        ]);
        assert.deepEqual(transactionLookups, ["0x1234"]);
        assert.deepEqual(progress, [
            "status=reading_current_allowance, desired=0.000000000000000075 WETH",
            "status=current_allowance_read, desired=0.000000000000000075 WETH, current=0.00000000000000001 WETH",
            "status=approval_required, desired=0.000000000000000075 WETH, current=0.00000000000000001 WETH",
            "status=submitting_approval, desired=0.000000000000000075 WETH, current=0.00000000000000001 WETH",
            "status=approval_submitted, tx=0x1234, desired=0.000000000000000075 WETH",
            "status=waiting_for_receipt, tx=0x1234, desired=0.000000000000000075 WETH, previous=0.00000000000000001 WETH",
        ]);
    });

    it("does not submit approval in dry-run mode", async () => {
        const service = new ViemWethAllowanceApprovalService(
            {
                ...createTransactionPolicyReadDefaults(),
                async readContract() {
                    return 10n;
                },
                async waitForTransactionReceipt() {
                    throw new Error("unexpected wait");
                },
            },
            {
                async writeContract() {
                    throw new Error("unexpected write");
                },
            },
            WETH,
            CONDUIT,
            TRANSACTION_POLICY,
        );

        const result = await service.ensureAllowance({
            ownerAddress: OWNER,
            desiredAllowanceWei: 75n,
            dryRun: true,
        });

        assert.equal(result.status, "dry_run");
        assert.equal(result.currentAllowanceWei, 10n);
    });

    it("uses fee-history priority fee when the node tip estimate is zero and history is above the floor", async () => {
        const writes: Array<{
            maxFeePerGas: bigint;
            maxPriorityFeePerGas: bigint;
        }> = [];
        const service = new ViemWethAllowanceApprovalService(
            {
                ...createTransactionPolicyReadDefaults(),
                async readContract() {
                    return 10n;
                },
                async waitForTransactionReceipt() {
                    return {};
                },
                async estimateFeesPerGas() {
                    return {
                        maxFeePerGas: 42_000_000_000n,
                        maxPriorityFeePerGas: 0n,
                    };
                },
                async getFeeHistory(args) {
                    assert.equal(args.blockCount, 20);
                    assert.deepEqual(args.rewardPercentiles, [70]);
                    return {
                        reward: [[20_000_000n], [69_000_000n], [35_000_000n]],
                    };
                },
            },
            {
                async writeContract(args) {
                    writes.push({
                        maxFeePerGas: args.maxFeePerGas,
                        maxPriorityFeePerGas: args.maxPriorityFeePerGas,
                    });
                    return "0x1234" as Hash;
                },
            },
            WETH,
            CONDUIT,
            {
                fees: {
                    minPriorityFeePerGasWei: 10_000_000n,
                    priorityFeeHistoryBlockCount: 20,
                    priorityFeeHistoryRewardPercentile: 70,
                    baseFeeMultiplierBps: 12_500n,
                    maxFeePerGasWei: 100_000_000_000n,
                },
                nonce: {
                    pendingNoncePolicy: "fail",
                },
            },
        );

        await service.ensureAllowance({
            ownerAddress: OWNER,
            desiredAllowanceWei: 75n,
        });

        assert.deepEqual(writes, [
            {
                maxFeePerGas: 50_069_000_000n,
                maxPriorityFeePerGas: 69_000_000n,
            },
        ]);
    });

    it("blocks approval submission when the maker already has pending nonce backlog", async () => {
        let writeCalls = 0;
        const service = new ViemWethAllowanceApprovalService(
            {
                ...createTransactionPolicyReadDefaults(),
                async readContract() {
                    return 10n;
                },
                async waitForTransactionReceipt() {
                    throw new Error("unexpected wait");
                },
                async getTransactionCount(args) {
                    return args.blockTag === "latest" ? 2 : 4;
                },
            },
            {
                async writeContract() {
                    writeCalls += 1;
                    return "0x1234" as Hash;
                },
            },
            WETH,
            CONDUIT,
            TRANSACTION_POLICY,
        );

        await assert.rejects(
            () =>
                service.ensureAllowance({
                    ownerAddress: OWNER,
                    desiredAllowanceWei: 75n,
                }),
            /pending nonce queue detected/,
        );
        assert.equal(writeCalls, 0);
    });
});

function createTransactionPolicyReadDefaults(): {
    getBlock(args: { blockTag: "latest" }): Promise<{
        number: bigint;
        baseFeePerGas: bigint;
    }>;
    estimateFeesPerGas(): Promise<{
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
    }>;
    getTransactionCount(args: {
        address: string;
        blockTag: "latest" | "pending";
    }): Promise<number>;
} {
    return {
        async getBlock() {
            return {
                number: 123n,
                baseFeePerGas: 40_000_000_000n,
            };
        },
        async estimateFeesPerGas() {
            return {
                maxFeePerGas: 42_000_000_000n,
                maxPriorityFeePerGas: 1_500_000_000n,
            };
        },
        async getTransactionCount() {
            return 0;
        },
    };
}
