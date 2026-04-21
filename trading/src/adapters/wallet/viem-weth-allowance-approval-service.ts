import {
    EvmTransactionPolicyService,
    formatEvmTransactionPolicyEvent,
    formatFeeMultiplierBps,
    formatOptionalGwei,
    formatWeiAsGwei,
    type EvmPreparedTransactionPolicy,
    type EvmTransactionPolicyConfig,
    type EvmTransactionPolicyEvent,
    type EvmTransactionPolicyReader,
} from "@artgod/shared/evm/transactions";
import { formatEther, getAddress, type Address, type Hash } from "viem";
import { biddingLog } from "../../utils/bidding-log.js";

const APPROVAL_RECEIPT_WAIT_LOG_INTERVAL_MS = 15_000;

const erc20AllowanceApprovalAbi = [
    {
        type: "function",
        stateMutability: "view",
        name: "allowance",
        inputs: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
        ],
        outputs: [{ name: "allowance", type: "uint256" }],
    },
    {
        type: "function",
        stateMutability: "nonpayable",
        name: "approve",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "ok", type: "bool" }],
    },
] as const;

type WethAllowanceReadClient = EvmTransactionPolicyReader & {
    readContract(args: {
        address: Address;
        abi: typeof erc20AllowanceApprovalAbi;
        functionName: "allowance";
        args: [Address, Address];
    }): Promise<bigint>;
    waitForTransactionReceipt(args: {
        hash: Hash;
        onReplaced?: (replacement: unknown) => void;
    }): Promise<unknown>;
    estimateContractGas?(args: {
        account: Address;
        address: Address;
        abi: typeof erc20AllowanceApprovalAbi;
        functionName: "approve";
        args: [Address, bigint];
    }): Promise<bigint>;
    getTransaction?(args: { hash: Hash }): Promise<{
        type?: string;
        nonce: number;
        gas: bigint;
        gasPrice?: bigint | null;
        maxFeePerGas?: bigint | null;
        maxPriorityFeePerGas?: bigint | null;
        blockHash?: Hash | null;
        blockNumber?: bigint | null;
    }>;
};

type WethAllowanceWriteClient = {
    writeContract(args: {
        address: Address;
        abi: typeof erc20AllowanceApprovalAbi;
        functionName: "approve";
        args: [Address, bigint];
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
    }): Promise<Hash>;
};

export type EnsureWethAllowanceInput = {
    ownerAddress: string;
    desiredAllowanceWei: bigint;
    dryRun?: boolean;
    onProgress?: (detail: string) => void;
};

export type EnsureWethAllowanceResult = {
    status: "disabled" | "sufficient" | "dry_run" | "approved";
    ownerAddress: Address;
    spenderAddress: Address;
    desiredAllowanceWei: bigint;
    currentAllowanceWei: bigint | null;
    transactionHash?: Hash;
};

// ViemWethAllowanceApprovalService owns the startup WETH approval transaction for OpenSea bidding.
export class ViemWethAllowanceApprovalService {
    private readonly wethAddress: Address;
    private readonly spenderAddress: Address;
    private readonly transactionPolicyService: EvmTransactionPolicyService;

    constructor(
        private readonly readClient: WethAllowanceReadClient,
        private readonly writeClient: WethAllowanceWriteClient,
        wethAddress: string,
        spenderAddress: string,
        transactionPolicyConfig: EvmTransactionPolicyConfig,
    ) {
        this.wethAddress = getAddress(wethAddress);
        this.spenderAddress = getAddress(spenderAddress);
        this.transactionPolicyService = new EvmTransactionPolicyService(
            readClient,
            transactionPolicyConfig,
            {
                onEvent: logTransactionPolicyEvent,
            },
        );
    }

    public async ensureAllowance(
        input: EnsureWethAllowanceInput,
    ): Promise<EnsureWethAllowanceResult> {
        const ownerAddress = getAddress(input.ownerAddress);
        const desiredAllowanceWei = input.desiredAllowanceWei;
        if (desiredAllowanceWei < 0n) {
            throw new Error(
                `WETH allowance must be non-negative. received=${desiredAllowanceWei}`,
            );
        }
        if (desiredAllowanceWei === 0n) {
            biddingLog.info(
                `[WethAllowanceApproval] Startup approval disabled because BIDDING_WETH_ALLOWANCE_ETH=0.`,
            );
            return {
                status: "disabled",
                ownerAddress,
                spenderAddress: this.spenderAddress,
                desiredAllowanceWei,
                currentAllowanceWei: null,
            };
        }

        biddingLog.info(
            `[WethAllowanceApproval] Ensuring startup WETH allowance. owner=${ownerAddress}, spender=${this.spenderAddress}, weth=${this.wethAddress}, desired=${formatWeth(desiredAllowanceWei)}, dryRun=${input.dryRun === true}`,
        );

        // Read the current WETH allowance before deciding whether an approval transaction is needed.
        input.onProgress?.(
            `status=reading_current_allowance, desired=${formatWeth(desiredAllowanceWei)}`,
        );
        biddingLog.info(
            `[WethAllowanceApproval] Reading current WETH allowance from chain. owner=${ownerAddress}, spender=${this.spenderAddress}`,
        );
        let currentAllowanceWei: bigint;
        try {
            currentAllowanceWei = await this.readClient.readContract({
                address: this.wethAddress,
                abi: erc20AllowanceApprovalAbi,
                functionName: "allowance",
                args: [ownerAddress, this.spenderAddress],
            });
        } catch (error) {
            biddingLog.error(
                `[WethAllowanceApproval] Failed to read current WETH allowance. owner=${ownerAddress}, spender=${this.spenderAddress}, error=${formatError(error)}`,
            );
            throw error;
        }

        biddingLog.info(
            `[WethAllowanceApproval] Current WETH allowance read. desired=${formatWeth(desiredAllowanceWei)}, current=${formatWeth(currentAllowanceWei)}`,
        );
        input.onProgress?.(
            `status=current_allowance_read, desired=${formatWeth(desiredAllowanceWei)}, current=${formatWeth(currentAllowanceWei)}`,
        );

        if (currentAllowanceWei >= desiredAllowanceWei) {
            biddingLog.info(
                `[WethAllowanceApproval] Existing WETH allowance is sufficient. desired=${formatWeth(desiredAllowanceWei)}, current=${formatWeth(currentAllowanceWei)}`,
            );
            return {
                status: "sufficient",
                ownerAddress,
                spenderAddress: this.spenderAddress,
                desiredAllowanceWei,
                currentAllowanceWei,
            };
        }

        biddingLog.info(
            `[WethAllowanceApproval] Existing WETH allowance is below desired allowance; approval is required. desired=${formatWeth(desiredAllowanceWei)}, current=${formatWeth(currentAllowanceWei)}`,
        );
        input.onProgress?.(
            `status=approval_required, desired=${formatWeth(desiredAllowanceWei)}, current=${formatWeth(currentAllowanceWei)}`,
        );

        if (input.dryRun) {
            biddingLog.info(
                `[WethAllowanceApproval] Dry-run mode would approve WETH allowance. desired=${formatWeth(desiredAllowanceWei)}, current=${formatWeth(currentAllowanceWei)}`,
            );
            return {
                status: "dry_run",
                ownerAddress,
                spenderAddress: this.spenderAddress,
                desiredAllowanceWei,
                currentAllowanceWei,
            };
        }

        // Resolve reusable fee and nonce policy immediately before the state-changing approval call.
        const approvalTransactionPolicy =
            await this.prepareApprovalTransactionPolicy({
                ownerAddress,
                desiredAllowanceWei,
            });
        input.onProgress?.(
            `status=submitting_approval, desired=${formatWeth(desiredAllowanceWei)}, current=${formatWeth(currentAllowanceWei)}`,
        );
        biddingLog.info(
            `[WethAllowanceApproval] Submitting WETH approval transaction. spender=${this.spenderAddress}, desired=${formatWeth(desiredAllowanceWei)}, maxFeePerGas=${formatWeiAsGwei(approvalTransactionPolicy.maxFeePerGasWei)}, maxPriorityFeePerGas=${formatWeiAsGwei(approvalTransactionPolicy.maxPriorityFeePerGasWei)}`,
        );
        let transactionHash: Hash;
        try {
            // Submit an exact WETH approval to the OpenSea conduit selected by the SDK for this chain.
            transactionHash = await this.writeClient.writeContract({
                address: this.wethAddress,
                abi: erc20AllowanceApprovalAbi,
                functionName: "approve",
                args: [this.spenderAddress, desiredAllowanceWei],
                maxFeePerGas: approvalTransactionPolicy.maxFeePerGasWei,
                maxPriorityFeePerGas:
                    approvalTransactionPolicy.maxPriorityFeePerGasWei,
            });
        } catch (error) {
            biddingLog.error(
                `[WethAllowanceApproval] Failed to submit WETH approval transaction. spender=${this.spenderAddress}, desired=${formatWeth(desiredAllowanceWei)}, error=${formatError(error)}`,
            );
            throw error;
        }

        biddingLog.info(
            `[WethAllowanceApproval] WETH approval transaction submitted. tx=${transactionHash}, desired=${formatWeth(desiredAllowanceWei)}`,
        );
        await this.logBroadcastTransaction(transactionHash);
        input.onProgress?.(
            `status=approval_submitted, tx=${transactionHash}, desired=${formatWeth(desiredAllowanceWei)}`,
        );
        try {
            await this.waitForApprovalReceipt({
                transactionHash,
                desiredAllowanceWei,
                currentAllowanceWei,
                onProgress: input.onProgress,
            });
        } catch (error) {
            biddingLog.error(
                `[WethAllowanceApproval] Failed while waiting for WETH approval receipt. tx=${transactionHash}, desired=${formatWeth(desiredAllowanceWei)}, previous=${formatWeth(currentAllowanceWei)}, error=${formatError(error)}`,
            );
            throw error;
        }

        biddingLog.info(
            `[WethAllowanceApproval] WETH approval transaction confirmed. desired=${formatWeth(desiredAllowanceWei)}, previous=${formatWeth(currentAllowanceWei)}, tx=${transactionHash}`,
        );
        return {
            status: "approved",
            ownerAddress,
            spenderAddress: this.spenderAddress,
            desiredAllowanceWei,
            currentAllowanceWei,
            transactionHash,
        };
    }

    private async prepareApprovalTransactionPolicy(params: {
        ownerAddress: Address;
        desiredAllowanceWei: bigint;
    }): Promise<EvmPreparedTransactionPolicy> {
        biddingLog.info(
            `[WethAllowanceApproval] Preparing approval transaction policy. owner=${params.ownerAddress}, spender=${this.spenderAddress}`,
        );

        const gasEstimate = await this.readOptionalGasEstimate(params);
        let transactionPolicy: EvmPreparedTransactionPolicy;
        try {
            transactionPolicy = await this.transactionPolicyService.prepare({
                context: "weth_approval",
                fromAddress: params.ownerAddress,
            });
        } catch (error) {
            biddingLog.error(
                `[WethAllowanceApproval] Failed to prepare approval transaction policy. owner=${params.ownerAddress}, spender=${this.spenderAddress}, error=${formatError(error)}`,
            );
            throw error;
        }

        biddingLog.info(
            `[WethAllowanceApproval] Approval transaction policy ready. gasEstimate=${formatOptionalInteger(gasEstimate)}, baseFee=${formatWeiAsGwei(transactionPolicy.baseFeePerGasWei)}, latestBlock=${formatOptionalInteger(transactionPolicy.blockNumber)}, nodeGasPrice=${formatOptionalGwei(transactionPolicy.nodeGasPriceWei)}, nodeMaxFeePerGas=${formatOptionalGwei(transactionPolicy.nodeMaxFeePerGasWei)}, nodeMaxPriorityFeePerGas=${formatOptionalGwei(transactionPolicy.nodeMaxPriorityFeePerGasWei)}, feeHistoryPriorityFeePerGas=${formatOptionalGwei(transactionPolicy.feeHistoryPriorityFeePerGasWei)}, configuredMinPriorityFee=${formatWeiAsGwei(transactionPolicy.configuredMinPriorityFeePerGasWei)}, configuredFeeHistoryBlockCount=${transactionPolicy.configuredPriorityFeeHistoryBlockCount}, configuredFeeHistoryRewardPercentile=${transactionPolicy.configuredPriorityFeeHistoryRewardPercentile}, configuredBaseFeeMultiplier=${formatFeeMultiplierBps(transactionPolicy.configuredBaseFeeMultiplierBps)}, configuredMaxFeeCap=${formatWeiAsGwei(transactionPolicy.configuredMaxFeePerGasWei)}, selectedMaxFeePerGas=${formatWeiAsGwei(transactionPolicy.maxFeePerGasWei)}, selectedMaxPriorityFeePerGas=${formatWeiAsGwei(transactionPolicy.maxPriorityFeePerGasWei)}, latestNonce=${transactionPolicy.latestNonce}, pendingNonce=${transactionPolicy.pendingNonce}`,
        );
        return transactionPolicy;
    }

    private async readOptionalGasEstimate(params: {
        ownerAddress: Address;
        desiredAllowanceWei: bigint;
    }): Promise<bigint | null> {
        if (!this.readClient.estimateContractGas) {
            return null;
        }
        try {
            // Estimate the exact approval call that will be submitted if allowance is still low.
            return await this.readClient.estimateContractGas({
                account: params.ownerAddress,
                address: this.wethAddress,
                abi: erc20AllowanceApprovalAbi,
                functionName: "approve",
                args: [this.spenderAddress, params.desiredAllowanceWei],
            });
        } catch (error) {
            biddingLog.warn(
                `[WethAllowanceApproval] Failed to estimate approval gas. error=${formatError(error)}`,
            );
            return null;
        }
    }

    private async readOptionalLatestBlock(): Promise<{
        number: bigint | null;
        baseFeePerGas: bigint | null;
    }> {
        try {
            const block = await this.readClient.getBlock({
                blockTag: "latest",
            });
            return {
                number: block.number,
                baseFeePerGas: block.baseFeePerGas ?? null,
            };
        } catch (error) {
            biddingLog.warn(
                `[WethAllowanceApproval] Failed to read latest block fee data. error=${formatError(error)}`,
            );
            return {
                number: null,
                baseFeePerGas: null,
            };
        }
    }

    private async logBroadcastTransaction(
        transactionHash: Hash,
    ): Promise<void> {
        const summary =
            await this.readBroadcastTransactionSummary(transactionHash);
        biddingLog.info(
            `[WethAllowanceApproval] Broadcast transaction state from node. tx=${transactionHash}, ${summary}`,
        );
    }

    private async readBroadcastTransactionSummary(
        transactionHash: Hash,
    ): Promise<string> {
        if (!this.readClient.getTransaction) {
            return "txLookup=unavailable";
        }
        try {
            const transaction = await this.readClient.getTransaction({
                hash: transactionHash,
            });
            return [
                "txLookup=found",
                `type=${transaction.type ?? "unknown"}`,
                `nonce=${transaction.nonce}`,
                `gasLimit=${transaction.gas.toString()}`,
                `gasPrice=${formatOptionalGwei(transaction.gasPrice ?? null)}`,
                `maxFeePerGas=${formatOptionalGwei(transaction.maxFeePerGas ?? null)}`,
                `maxPriorityFeePerGas=${formatOptionalGwei(transaction.maxPriorityFeePerGas ?? null)}`,
                `block=${formatOptionalInteger(transaction.blockNumber ?? null)}`,
                `blockHash=${transaction.blockHash ?? "pending"}`,
            ].join(", ");
        } catch (error) {
            return `txLookup=failed, error=${formatError(error)}`;
        }
    }

    private async waitForApprovalReceipt(params: {
        transactionHash: Hash;
        desiredAllowanceWei: bigint;
        currentAllowanceWei: bigint;
        onProgress?: (detail: string) => void;
    }): Promise<void> {
        const startedAt = Date.now();
        params.onProgress?.(
            `status=waiting_for_receipt, tx=${params.transactionHash}, desired=${formatWeth(params.desiredAllowanceWei)}, previous=${formatWeth(params.currentAllowanceWei)}`,
        );
        biddingLog.info(
            `[WethAllowanceApproval] Waiting for WETH approval receipt. tx=${params.transactionHash}, desired=${formatWeth(params.desiredAllowanceWei)}, previous=${formatWeth(params.currentAllowanceWei)}`,
        );
        let heartbeatInFlight = false;
        const waitLogInterval = setInterval(() => {
            if (heartbeatInFlight) {
                return;
            }
            heartbeatInFlight = true;
            void this.logApprovalReceiptWaitHeartbeat(
                params,
                Date.now() - startedAt,
            ).finally(() => {
                heartbeatInFlight = false;
            });
        }, APPROVAL_RECEIPT_WAIT_LOG_INTERVAL_MS);

        try {
            // Wait for the approval transaction to be included before continuing bidder bootstrap.
            await this.readClient.waitForTransactionReceipt({
                hash: params.transactionHash,
                onReplaced: (replacement) => {
                    biddingLog.warn(
                        `[WethAllowanceApproval] WETH approval transaction was replaced while waiting. originalTx=${params.transactionHash}, ${formatReceiptReplacement(replacement)}`,
                    );
                },
            });
        } finally {
            clearInterval(waitLogInterval);
        }
    }

    private async logApprovalReceiptWaitHeartbeat(
        params: {
            transactionHash: Hash;
            desiredAllowanceWei: bigint;
            currentAllowanceWei: bigint;
            onProgress?: (detail: string) => void;
        },
        elapsedMs: number,
    ): Promise<void> {
        const elapsed = formatElapsed(elapsedMs);
        params.onProgress?.(
            `status=waiting_for_receipt, tx=${params.transactionHash}, elapsed=${elapsed}, desired=${formatWeth(params.desiredAllowanceWei)}, previous=${formatWeth(params.currentAllowanceWei)}`,
        );
        const [transactionSummary, latestBlock] = await Promise.all([
            this.readBroadcastTransactionSummary(params.transactionHash),
            this.readOptionalLatestBlock(),
        ]);
        biddingLog.info(
            `[WethAllowanceApproval] Still waiting for WETH approval receipt. tx=${params.transactionHash}, elapsed=${elapsed}, desired=${formatWeth(params.desiredAllowanceWei)}, previous=${formatWeth(params.currentAllowanceWei)}, latestBlock=${formatOptionalInteger(latestBlock.number)}, baseFee=${formatOptionalGwei(latestBlock.baseFeePerGas)}, ${transactionSummary}`,
        );
    }
}

function formatWeth(amountWei: bigint): string {
    return `${formatEther(amountWei)} WETH`;
}

function formatElapsed(elapsedMs: number): string {
    return `${Math.floor(elapsedMs / 1000)}s`;
}

function formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    return String(error);
}

function formatOptionalInteger(value: bigint | number | null): string {
    return value === null ? "n/a" : value.toString();
}

function logTransactionPolicyEvent(event: EvmTransactionPolicyEvent): void {
    const message = `[WethAllowanceApproval] ${formatEvmTransactionPolicyEvent(event)}`;
    if (
        event.type === "read_failed" ||
        event.type === "pending_nonce_detected"
    ) {
        biddingLog.warn(message);
        return;
    }
    biddingLog.info(message);
}

function formatReceiptReplacement(replacement: unknown): string {
    if (!replacement || typeof replacement !== "object") {
        return `replacement=${String(replacement)}`;
    }
    const value = replacement as {
        reason?: unknown;
        replacedTransaction?: { hash?: unknown };
        transaction?: { hash?: unknown };
        transactionReceipt?: { transactionHash?: unknown; status?: unknown };
    };
    return [
        `reason=${value.reason ?? "unknown"}`,
        `replacedTx=${value.replacedTransaction?.hash ?? "unknown"}`,
        `replacementTx=${value.transaction?.hash ?? "unknown"}`,
        `receiptTx=${value.transactionReceipt?.transactionHash ?? "unknown"}`,
        `receiptStatus=${value.transactionReceipt?.status ?? "unknown"}`,
    ].join(", ");
}
