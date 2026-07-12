import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import type { Hash } from "viem";
import type { EvmTransactionPolicyConfig } from "@artgod/shared/evm/transactions";
import {
    ViemWethAllowanceApprovalService,
    WETH_ALLOWANCE_POST_CONFIRMATION_ERROR,
    WETH_ALLOWANCE_RECONCILIATION_STATUS,
    WETH_APPROVAL_GAS_FEE_CAP_ERROR,
} from "./viem-weth-allowance-approval-service.js";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const OWNER = "0x00000000000000000000000000000000000000aA";
const CONDUIT = "0x1E0049783F008A0085193E00003D00CD54003c71";
const CONDUIT_CHECKSUM = "0x1E0049783F008A0085193E00003D00cd54003c71";
const MAX_APPROVAL_GAS_FEE_WEI = 1_000_000_000_000_000_000n;
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
    it("keeps a zero allowance when it already matches the configured cap", async () => {
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
            approvalAuthorization(0n),
        );

        const result = await service.ensureAllowance({
            ownerAddress: OWNER,
        });

        assert.equal(result.status, WETH_ALLOWANCE_RECONCILIATION_STATUS.Exact);
        assert.equal(result.currentAllowanceWei, 0n);
        assert.equal(readCalls, 1);
        assert.equal(writeCalls, 0);
    });

    it("does not transact when the current allowance exactly matches the configured cap", async () => {
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
                    return 50n;
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
            approvalAuthorization(50n),
        );

        const result = await service.ensureAllowance({
            ownerAddress: OWNER,
        });

        assert.equal(result.status, WETH_ALLOWANCE_RECONCILIATION_STATUS.Exact);
        assert.equal(result.currentAllowanceWei, 50n);
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

    it("revokes an existing allowance when the configured cap is zero", async () => {
        const writes: Array<{ amount: bigint; gas: bigint }> = [];
        let allowanceReadCalls = 0;
        const service = new ViemWethAllowanceApprovalService(
            {
                ...createTransactionPolicyReadDefaults(),
                async readContract() {
                    allowanceReadCalls += 1;
                    return allowanceReadCalls === 1 ? 2n ** 256n - 1n : 0n;
                },
                async waitForTransactionReceipt() {
                    return {};
                },
            },
            {
                async writeContract(args) {
                    writes.push({ amount: args.args[1], gas: args.gas });
                    return "0x01" as Hash;
                },
            },
            WETH,
            CONDUIT,
            approvalAuthorization(0n),
        );

        const result = await service.ensureAllowance({
            ownerAddress: OWNER,
        });

        assert.equal(
            result.status,
            WETH_ALLOWANCE_RECONCILIATION_STATUS.Updated,
        );
        assert.deepEqual(writes, [{ amount: 0n, gas: 60_000n }]);
        assert.equal(result.previousAllowanceWei, 2n ** 256n - 1n);
        assert.equal(result.currentAllowanceWei, 0n);
        assert.equal(allowanceReadCalls, 2);
    });

    it("approves the exact configured allowance and waits for confirmation when allowance is low", async () => {
        const writes: Array<{
            functionName: string;
            args: readonly [string, bigint];
            gas: bigint;
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
        let allowanceReadCalls = 0;
        const service = new ViemWethAllowanceApprovalService(
            {
                async readContract() {
                    allowanceReadCalls += 1;
                    return allowanceReadCalls === 1 ? 10n : 75n;
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
                        gas: args.gas,
                        maxFeePerGas: args.maxFeePerGas,
                        maxPriorityFeePerGas: args.maxPriorityFeePerGas,
                    });
                    return "0x1234" as Hash;
                },
            },
            WETH,
            CONDUIT,
            approvalAuthorization(75n),
        );

        const result = await service.ensureAllowance({
            ownerAddress: OWNER,
            onProgress(detail) {
                progress.push(detail);
            },
        });

        assert.equal(
            result.status,
            WETH_ALLOWANCE_RECONCILIATION_STATUS.Updated,
        );
        assert.equal(result.previousAllowanceWei, 10n);
        assert.equal(result.currentAllowanceWei, 75n);
        assert.equal(result.transactionHash, "0x1234");
        assert.equal(allowanceReadCalls, 2);
        assert.deepEqual(writes, [
            {
                functionName: "approve",
                args: [CONDUIT_CHECKSUM, 75n],
                gas: 60_000n,
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
            approvalAuthorization(75n),
        );

        const result = await service.ensureAllowance({
            ownerAddress: OWNER,
            dryRun: true,
        });

        assert.equal(
            result.status,
            WETH_ALLOWANCE_RECONCILIATION_STATUS.DryRun,
        );
        assert.equal(result.previousAllowanceWei, 10n);
        assert.equal(result.currentAllowanceWei, 10n);
    });

    it("fails closed when receipt confirmation does not establish the exact cap", async () => {
        let writeCalls = 0;
        const service = new ViemWethAllowanceApprovalService(
            {
                ...createTransactionPolicyReadDefaults(),
                async readContract() {
                    return 10n;
                },
                async waitForTransactionReceipt() {
                    return {};
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
            approvalAuthorization(75n),
        );

        await assert.rejects(
            () =>
                service.ensureAllowance({
                    ownerAddress: OWNER,
                }),
            new RegExp(WETH_ALLOWANCE_POST_CONFIRMATION_ERROR),
        );
        assert.equal(writeCalls, 1);
    });

    it("rejects approval when its worst-case gas fee exceeds the configured cap", async () => {
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
            },
            {
                async writeContract() {
                    writeCalls += 1;
                    return "0x01" as Hash;
                },
            },
            WETH,
            CONDUIT,
            approvalAuthorization(75n, TRANSACTION_POLICY, 1n),
        );

        await assert.rejects(
            () =>
                service.ensureAllowance({
                    ownerAddress: OWNER,
                }),
            new RegExp(WETH_APPROVAL_GAS_FEE_CAP_ERROR),
        );
        assert.equal(writeCalls, 0);
    });

    it("uses fee-history priority fee when the node tip estimate is zero and history is above the floor", async () => {
        const writes: Array<{
            maxFeePerGas: bigint;
            maxPriorityFeePerGas: bigint;
        }> = [];
        let allowanceReadCalls = 0;
        const service = new ViemWethAllowanceApprovalService(
            {
                ...createTransactionPolicyReadDefaults(),
                async readContract() {
                    allowanceReadCalls += 1;
                    return allowanceReadCalls === 1 ? 10n : 75n;
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
            approvalAuthorization(75n, {
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
            }),
        );

        await service.ensureAllowance({
            ownerAddress: OWNER,
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
            approvalAuthorization(75n),
        );

        await assert.rejects(
            () =>
                service.ensureAllowance({
                    ownerAddress: OWNER,
                }),
            /pending nonce queue detected/,
        );
        assert.equal(writeCalls, 0);
    });
});

function approvalAuthorization(
    allowanceWei: bigint,
    transactionPolicy: EvmTransactionPolicyConfig = TRANSACTION_POLICY,
    maxTotalGasFeeWei: bigint = MAX_APPROVAL_GAS_FEE_WEI,
) {
    return {
        allowanceWei,
        transactionPolicy,
        maxTotalGasFeeWei,
    };
}

function createTransactionPolicyReadDefaults(): {
    estimateContractGas(): Promise<bigint>;
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
        async estimateContractGas() {
            return 50_000n;
        },
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
