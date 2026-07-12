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
import { OPENSEA_MAINNET_SECURITY_POLICY } from "@artgod/shared/trading/open-sea-mainnet-security-policy";
import { formatEther, getAddress, type Address, type Hash } from "viem";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../utils/bidding-log.js";

const APPROVAL_RECEIPT_WAIT_LOG_INTERVAL_MS = 15_000;
// WETH approval gas receives modest deterministic headroom above the node estimate.
const APPROVAL_GAS_LIMIT_HEADROOM_BPS = 12_000n;
const BASIS_POINTS_DENOMINATOR = 10_000n;
const WETH_APPROVAL_LOG_FIELD = {
    GasEstimate: "gasEstimate",
    GasLimit: "gasLimit",
    WorstCaseGasFeeWei: "worstCaseGasFeeWei",
    AuthorizedMaxGasFeeWei: "authorizedMaxGasFeeWei",
} as const;
const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.WethAllowanceApprovalService,
);

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
    estimateContractGas(args: {
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
        gas: bigint;
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
    }): Promise<Hash>;
};

export type EnsureWethAllowanceInput = {
    ownerAddress: string;
    dryRun?: boolean;
    onProgress?: (detail: string) => void;
};

// Carries the exact mandate-owned authority for one WETH approval lane.
export type WethApprovalAuthorization = {
    allowanceWei: bigint;
    transactionPolicy: EvmTransactionPolicyConfig;
    maxTotalGasFeeWei: bigint;
};

// Result states for exact startup reconciliation of the OpenSea conduit allowance cap.
export const WETH_ALLOWANCE_RECONCILIATION_STATUS = {
    Exact: "exact",
    DryRun: "dry_run",
    Updated: "updated",
} as const;

// Stable error prefix emitted when explicit approval gas cannot fit the operator's gas fee cap.
export const WETH_APPROVAL_GAS_FEE_CAP_ERROR =
    "WETH approval worst-case gas fee exceeds authorized cap";

// Stable error prefix emitted when the confirmed approval did not establish the exact authorized cap.
export const WETH_ALLOWANCE_POST_CONFIRMATION_ERROR =
    "Confirmed WETH approval did not establish the authorized allowance cap";

export type EnsureWethAllowanceResult = {
    status: (typeof WETH_ALLOWANCE_RECONCILIATION_STATUS)[keyof typeof WETH_ALLOWANCE_RECONCILIATION_STATUS];
    ownerAddress: Address;
    spenderAddress: Address;
    desiredAllowanceWei: bigint;
    previousAllowanceWei: bigint;
    currentAllowanceWei: bigint;
    transactionHash?: Hash;
};

type PreparedWethApprovalTransaction = {
    transactionPolicy: EvmPreparedTransactionPolicy;
    gasEstimate: bigint;
    gasLimit: bigint;
    worstCaseGasFeeWei: bigint;
};

type WethApprovalSubmission = Parameters<
    WethAllowanceWriteClient["writeContract"]
>[0];

// ViemWethAllowanceApprovalService owns the startup WETH approval transaction for OpenSea bidding.
export class ViemWethAllowanceApprovalService {
    private readonly wethAddress: Address;
    private readonly spenderAddress: Address;
    private readonly transactionPolicyService: EvmTransactionPolicyService;
    private readonly authorization: Readonly<WethApprovalAuthorization>;

    constructor(
        private readonly readClient: WethAllowanceReadClient,
        private readonly writeClient: WethAllowanceWriteClient,
        wethAddress: string,
        spenderAddress: string,
        authorization: WethApprovalAuthorization,
    ) {
        this.wethAddress = getAddress(wethAddress);
        this.spenderAddress = getAddress(spenderAddress);
        this.assertPinnedApprovalTarget();
        this.authorization = Object.freeze({
            allowanceWei: authorization.allowanceWei,
            maxTotalGasFeeWei: authorization.maxTotalGasFeeWei,
            transactionPolicy: Object.freeze({
                fees: Object.freeze({ ...authorization.transactionPolicy.fees }),
                nonce: Object.freeze({ ...authorization.transactionPolicy.nonce }),
            }),
        });
        this.transactionPolicyService = new EvmTransactionPolicyService(
            readClient,
            this.authorization.transactionPolicy,
            {
                onEvent: logTransactionPolicyEvent,
            },
        );
        if (authorization.allowanceWei < 0n) {
            throw new Error("Authorized WETH allowance must be non-negative");
        }
        if (authorization.maxTotalGasFeeWei <= 0n) {
            throw new Error("WETH approval maximum gas fee must be positive");
        }
    }

    public async ensureAllowance(
        input: EnsureWethAllowanceInput,
    ): Promise<EnsureWethAllowanceResult> {
        const ownerAddress = getAddress(input.ownerAddress);
        const desiredAllowanceWei = this.authorization.allowanceWei;
        log.info(
            "ensureAllowanceStarted",
            "Reconciling startup WETH allowance cap",
            {
                ownerAddress,
                spenderAddress: this.spenderAddress,
                wethAddress: this.wethAddress,
                desiredAllowanceWei: desiredAllowanceWei.toString(),
                desiredAllowanceWeth: formatWeth(desiredAllowanceWei),
                dryRun: input.dryRun === true,
            },
        );

        // Read the current WETH allowance before deciding whether an approval transaction is needed.
        input.onProgress?.(
            `status=reading_current_allowance, desired=${formatWeth(desiredAllowanceWei)}`,
        );
        log.info(
            "currentAllowanceReadStarted",
            "Reading current WETH allowance from chain",
            {
                ownerAddress,
                spenderAddress: this.spenderAddress,
                wethAddress: this.wethAddress,
            },
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
            log.error(
                "currentAllowanceReadFailed",
                "Failed to read current WETH allowance",
                {
                    ownerAddress,
                    spenderAddress: this.spenderAddress,
                    wethAddress: this.wethAddress,
                    ...toErrorLogFields(error),
                },
            );
            throw error;
        }

        log.info("currentAllowanceRead", "Current WETH allowance read", {
            desiredAllowanceWei: desiredAllowanceWei.toString(),
            desiredAllowanceWeth: formatWeth(desiredAllowanceWei),
            currentAllowanceWei: currentAllowanceWei.toString(),
            currentAllowanceWeth: formatWeth(currentAllowanceWei),
        });
        input.onProgress?.(
            `status=current_allowance_read, desired=${formatWeth(desiredAllowanceWei)}, current=${formatWeth(currentAllowanceWei)}`,
        );

        if (currentAllowanceWei === desiredAllowanceWei) {
            log.info(
                "allowanceSufficient",
                "Existing WETH allowance matches the authorized cap",
                {
                    desiredAllowanceWei: desiredAllowanceWei.toString(),
                    desiredAllowanceWeth: formatWeth(desiredAllowanceWei),
                    currentAllowanceWei: currentAllowanceWei.toString(),
                    currentAllowanceWeth: formatWeth(currentAllowanceWei),
                },
            );
            return {
                status: WETH_ALLOWANCE_RECONCILIATION_STATUS.Exact,
                ownerAddress,
                spenderAddress: this.spenderAddress,
                desiredAllowanceWei,
                previousAllowanceWei: currentAllowanceWei,
                currentAllowanceWei,
            };
        }

        log.info(
            "approvalRequired",
            "Existing WETH allowance does not match the authorized cap",
            {
                desiredAllowanceWei: desiredAllowanceWei.toString(),
                desiredAllowanceWeth: formatWeth(desiredAllowanceWei),
                currentAllowanceWei: currentAllowanceWei.toString(),
                currentAllowanceWeth: formatWeth(currentAllowanceWei),
            },
        );
        input.onProgress?.(
            `status=approval_required, desired=${formatWeth(desiredAllowanceWei)}, current=${formatWeth(currentAllowanceWei)}`,
        );

        if (input.dryRun) {
            log.info("dryRunApproval", "Dry run would approve WETH allowance", {
                desiredAllowanceWei: desiredAllowanceWei.toString(),
                desiredAllowanceWeth: formatWeth(desiredAllowanceWei),
                currentAllowanceWei: currentAllowanceWei.toString(),
                currentAllowanceWeth: formatWeth(currentAllowanceWei),
            });
            return {
                status: WETH_ALLOWANCE_RECONCILIATION_STATUS.DryRun,
                ownerAddress,
                spenderAddress: this.spenderAddress,
                desiredAllowanceWei,
                previousAllowanceWei: currentAllowanceWei,
                currentAllowanceWei,
            };
        }

        // Resolve reusable fee and nonce policy immediately before the state-changing approval call.
        const preparedApproval = await this.prepareApprovalTransactionPolicy({
            ownerAddress,
            desiredAllowanceWei,
        });
        input.onProgress?.(
            `status=submitting_approval, desired=${formatWeth(desiredAllowanceWei)}, current=${formatWeth(currentAllowanceWei)}`,
        );
        log.info(
            "approvalSubmitStarted",
            "Submitting WETH approval transaction",
            {
                spenderAddress: this.spenderAddress,
                desiredAllowanceWei: desiredAllowanceWei.toString(),
                desiredAllowanceWeth: formatWeth(desiredAllowanceWei),
                maxFeePerGasWei:
                    preparedApproval.transactionPolicy.maxFeePerGasWei.toString(),
                maxFeePerGasGwei: formatWeiAsGwei(
                    preparedApproval.transactionPolicy.maxFeePerGasWei,
                ),
                maxPriorityFeePerGasWei:
                    preparedApproval.transactionPolicy.maxPriorityFeePerGasWei.toString(),
                maxPriorityFeePerGasGwei: formatWeiAsGwei(
                    preparedApproval.transactionPolicy.maxPriorityFeePerGasWei,
                ),
                [WETH_APPROVAL_LOG_FIELD.GasEstimate]:
                    preparedApproval.gasEstimate.toString(),
                [WETH_APPROVAL_LOG_FIELD.GasLimit]:
                    preparedApproval.gasLimit.toString(),
                [WETH_APPROVAL_LOG_FIELD.WorstCaseGasFeeWei]:
                    preparedApproval.worstCaseGasFeeWei.toString(),
                [WETH_APPROVAL_LOG_FIELD.AuthorizedMaxGasFeeWei]:
                    this.authorization.maxTotalGasFeeWei.toString(),
            },
        );
        let transactionHash: Hash;
        try {
            const submission: WethApprovalSubmission = {
                address: this.wethAddress,
                abi: erc20AllowanceApprovalAbi,
                functionName: "approve",
                args: [this.spenderAddress, desiredAllowanceWei],
                gas: preparedApproval.gasLimit,
                maxFeePerGas:
                    preparedApproval.transactionPolicy.maxFeePerGasWei,
                maxPriorityFeePerGas:
                    preparedApproval.transactionPolicy.maxPriorityFeePerGasWei,
            };
            // Reassert the complete mandate authority immediately before the state-changing call.
            this.assertAuthorizedApprovalSubmission(
                submission,
                preparedApproval,
            );
            transactionHash = await this.writeClient.writeContract(submission);
        } catch (error) {
            log.error(
                "approvalSubmitFailed",
                "Failed to submit WETH approval transaction",
                {
                    spenderAddress: this.spenderAddress,
                    desiredAllowanceWei: desiredAllowanceWei.toString(),
                    desiredAllowanceWeth: formatWeth(desiredAllowanceWei),
                    ...toErrorLogFields(error),
                },
            );
            throw error;
        }

        log.info("approvalSubmitted", "WETH approval transaction submitted", {
            transactionHash,
            desiredAllowanceWei: desiredAllowanceWei.toString(),
            desiredAllowanceWeth: formatWeth(desiredAllowanceWei),
        });
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
            log.error(
                "approvalReceiptWaitFailed",
                "Failed while waiting for WETH approval receipt",
                {
                    transactionHash,
                    desiredAllowanceWei: desiredAllowanceWei.toString(),
                    desiredAllowanceWeth: formatWeth(desiredAllowanceWei),
                    previousAllowanceWei: currentAllowanceWei.toString(),
                    previousAllowanceWeth: formatWeth(currentAllowanceWei),
                    ...toErrorLogFields(error),
                },
            );
            throw error;
        }

        // Re-read after confirmation so replacement, revert, or stale-provider outcomes fail closed.
        const confirmedAllowanceWei = await this.readConfirmedAllowance({
            ownerAddress,
            desiredAllowanceWei,
            transactionHash,
        });

        log.info("approvalConfirmed", "WETH approval transaction confirmed", {
            transactionHash,
            desiredAllowanceWei: desiredAllowanceWei.toString(),
            desiredAllowanceWeth: formatWeth(desiredAllowanceWei),
            previousAllowanceWei: currentAllowanceWei.toString(),
            previousAllowanceWeth: formatWeth(currentAllowanceWei),
            currentAllowanceWei: confirmedAllowanceWei.toString(),
            currentAllowanceWeth: formatWeth(confirmedAllowanceWei),
        });
        return {
            status: WETH_ALLOWANCE_RECONCILIATION_STATUS.Updated,
            ownerAddress,
            spenderAddress: this.spenderAddress,
            desiredAllowanceWei,
            previousAllowanceWei: currentAllowanceWei,
            currentAllowanceWei: confirmedAllowanceWei,
            transactionHash,
        };
    }

    private async readConfirmedAllowance(params: {
        ownerAddress: Address;
        desiredAllowanceWei: bigint;
        transactionHash: Hash;
    }): Promise<bigint> {
        let confirmedAllowanceWei: bigint;
        try {
            // Read the exact owner/conduit allowance after receipt confirmation.
            confirmedAllowanceWei = await this.readClient.readContract({
                address: this.wethAddress,
                abi: erc20AllowanceApprovalAbi,
                functionName: "allowance",
                args: [params.ownerAddress, this.spenderAddress],
            });
        } catch (error) {
            log.error(
                "confirmedAllowanceReadFailed",
                "Failed to verify confirmed WETH allowance",
                {
                    transactionHash: params.transactionHash,
                    ownerAddress: params.ownerAddress,
                    spenderAddress: this.spenderAddress,
                    ...toErrorLogFields(error),
                },
            );
            throw error;
        }

        if (confirmedAllowanceWei !== params.desiredAllowanceWei) {
            throw new Error(
                `${WETH_ALLOWANCE_POST_CONFIRMATION_ERROR}: expected=${params.desiredAllowanceWei} wei, received=${confirmedAllowanceWei} wei, tx=${params.transactionHash}`,
            );
        }
        return confirmedAllowanceWei;
    }

    private async prepareApprovalTransactionPolicy(params: {
        ownerAddress: Address;
        desiredAllowanceWei: bigint;
    }): Promise<PreparedWethApprovalTransaction> {
        log.info(
            "approvalPolicyPrepareStarted",
            "Preparing approval transaction policy",
            {
                ownerAddress: params.ownerAddress,
                spenderAddress: this.spenderAddress,
                desiredAllowanceWei: params.desiredAllowanceWei.toString(),
                desiredAllowanceWeth: formatWeth(params.desiredAllowanceWei),
            },
        );

        const gasEstimate = await this.readRequiredGasEstimate(params);
        let transactionPolicy: EvmPreparedTransactionPolicy;
        try {
            transactionPolicy = await this.transactionPolicyService.prepare({
                context: "weth_approval",
                fromAddress: params.ownerAddress,
            });
        } catch (error) {
            log.error(
                "approvalPolicyPrepareFailed",
                "Failed to prepare approval transaction policy",
                {
                    ownerAddress: params.ownerAddress,
                    spenderAddress: this.spenderAddress,
                    ...toErrorLogFields(error),
                },
            );
            throw error;
        }

        const gasLimit = multiplyByBpsCeil(
            gasEstimate,
            APPROVAL_GAS_LIMIT_HEADROOM_BPS,
        );
        const worstCaseGasFeeWei =
            gasLimit * transactionPolicy.maxFeePerGasWei;
        if (
            worstCaseGasFeeWei >
            this.authorization.maxTotalGasFeeWei
        ) {
            throw new Error(
                `${WETH_APPROVAL_GAS_FEE_CAP_ERROR}: worstCase=${worstCaseGasFeeWei} wei, cap=${this.authorization.maxTotalGasFeeWei} wei`,
            );
        }

        log.info("approvalPolicyReady", "Approval transaction policy ready", {
            [WETH_APPROVAL_LOG_FIELD.GasEstimate]: gasEstimate.toString(),
            [WETH_APPROVAL_LOG_FIELD.GasLimit]: gasLimit.toString(),
            [WETH_APPROVAL_LOG_FIELD.WorstCaseGasFeeWei]:
                worstCaseGasFeeWei.toString(),
            [WETH_APPROVAL_LOG_FIELD.AuthorizedMaxGasFeeWei]:
                this.authorization.maxTotalGasFeeWei.toString(),
            baseFeePerGasWei: transactionPolicy.baseFeePerGasWei.toString(),
            baseFeePerGasGwei: formatWeiAsGwei(
                transactionPolicy.baseFeePerGasWei,
            ),
            latestBlockNumber:
                transactionPolicy.blockNumber?.toString() ?? null,
            nodeGasPriceGwei: formatOptionalGwei(
                transactionPolicy.nodeGasPriceWei,
            ),
            nodeMaxFeePerGasGwei: formatOptionalGwei(
                transactionPolicy.nodeMaxFeePerGasWei,
            ),
            nodeMaxPriorityFeePerGasGwei: formatOptionalGwei(
                transactionPolicy.nodeMaxPriorityFeePerGasWei,
            ),
            feeHistoryPriorityFeePerGasGwei: formatOptionalGwei(
                transactionPolicy.feeHistoryPriorityFeePerGasWei,
            ),
            configuredMinPriorityFeeGwei: formatWeiAsGwei(
                transactionPolicy.configuredMinPriorityFeePerGasWei,
            ),
            configuredPriorityFeeHistoryBlockCount:
                transactionPolicy.configuredPriorityFeeHistoryBlockCount,
            configuredPriorityFeeHistoryRewardPercentile:
                transactionPolicy.configuredPriorityFeeHistoryRewardPercentile,
            configuredBaseFeeMultiplier: formatFeeMultiplierBps(
                transactionPolicy.configuredBaseFeeMultiplierBps,
            ),
            configuredMaxFeeCapGwei: formatWeiAsGwei(
                transactionPolicy.configuredMaxFeePerGasWei,
            ),
            selectedMaxFeePerGasWei:
                transactionPolicy.maxFeePerGasWei.toString(),
            selectedMaxFeePerGasGwei: formatWeiAsGwei(
                transactionPolicy.maxFeePerGasWei,
            ),
            selectedMaxPriorityFeePerGasWei:
                transactionPolicy.maxPriorityFeePerGasWei.toString(),
            selectedMaxPriorityFeePerGasGwei: formatWeiAsGwei(
                transactionPolicy.maxPriorityFeePerGasWei,
            ),
            latestNonce: transactionPolicy.latestNonce,
            pendingNonce: transactionPolicy.pendingNonce,
        });
        return {
            transactionPolicy,
            gasEstimate,
            gasLimit,
            worstCaseGasFeeWei,
        };
    }

    private assertPinnedApprovalTarget(): void {
        if (
            this.wethAddress !==
            getAddress(OPENSEA_MAINNET_SECURITY_POLICY.wethAddress)
        ) {
            throw new Error("WETH approval token does not match the pinned policy");
        }
        if (
            this.spenderAddress !==
            getAddress(OPENSEA_MAINNET_SECURITY_POLICY.conduitAddress)
        ) {
            throw new Error(
                "WETH approval spender does not match the pinned OpenSea conduit",
            );
        }
    }

    private assertAuthorizedApprovalSubmission(
        submission: WethApprovalSubmission,
        prepared: PreparedWethApprovalTransaction,
    ): void {
        this.assertPinnedApprovalTarget();
        const authorizedFees = this.authorization.transactionPolicy.fees;
        if (submission.maxFeePerGas > authorizedFees.maxFeePerGasWei) {
            throw new Error(
                "WETH approval maximum fee per gas exceeds the authorized cap",
            );
        }
        if (
            submission.maxPriorityFeePerGas <
                authorizedFees.minPriorityFeePerGasWei ||
            submission.maxPriorityFeePerGas > submission.maxFeePerGas
        ) {
            throw new Error(
                "WETH approval priority fee is outside the authorized relationship",
            );
        }
        const worstCaseGasFeeWei = submission.gas * submission.maxFeePerGas;
        if (
            worstCaseGasFeeWei !== prepared.worstCaseGasFeeWei ||
            worstCaseGasFeeWei > this.authorization.maxTotalGasFeeWei
        ) {
            throw new Error(
                "WETH approval worst-case gas fee is outside the authorized cap",
            );
        }
        if (
            submission.address !== this.wethAddress ||
            submission.functionName !== "approve" ||
            submission.args[0] !== this.spenderAddress ||
            submission.args[1] !== this.authorization.allowanceWei
        ) {
            throw new Error(
                "WETH approval calldata does not match the authorized token, conduit, and allowance",
            );
        }
    }

    private async readRequiredGasEstimate(params: {
        ownerAddress: Address;
        desiredAllowanceWei: bigint;
    }): Promise<bigint> {
        try {
            // Estimate the exact approval call that will be submitted if allowance is still low.
            const gasEstimate = await this.readClient.estimateContractGas({
                account: params.ownerAddress,
                address: this.wethAddress,
                abi: erc20AllowanceApprovalAbi,
                functionName: "approve",
                args: [this.spenderAddress, params.desiredAllowanceWei],
            });
            if (gasEstimate <= 0n) {
                throw new Error("RPC returned a non-positive gas estimate");
            }
            return gasEstimate;
        } catch (error) {
            log.error(
                "approvalGasEstimateFailed",
                "Failed to estimate approval gas",
                {
                    ownerAddress: params.ownerAddress,
                    spenderAddress: this.spenderAddress,
                    desiredAllowanceWei: params.desiredAllowanceWei.toString(),
                    ...toErrorLogFields(error),
                },
            );
            throw new Error(
                "Cannot enforce WETH approval gas fee cap without a gas estimate",
                {
                    cause: error,
                },
            );
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
            log.warn(
                "latestBlockReadFailed",
                "Failed to read latest block fee data",
                {
                    ...toErrorLogFields(error),
                },
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
        const transactionFields =
            await this.readBroadcastTransactionFields(transactionHash);
        log.info(
            "broadcastTransactionRead",
            "Broadcast transaction state from node",
            {
                transactionHash,
                ...transactionFields,
            },
        );
    }

    private async readBroadcastTransactionFields(
        transactionHash: Hash,
    ): Promise<Record<string, unknown>> {
        if (!this.readClient.getTransaction) {
            return { transactionLookup: "unavailable" };
        }
        try {
            const transaction = await this.readClient.getTransaction({
                hash: transactionHash,
            });
            return {
                transactionLookup: "found",
                transactionType: transaction.type ?? "unknown",
                nonce: transaction.nonce,
                gasLimitWei: transaction.gas.toString(),
                gasPriceGwei: formatOptionalGwei(transaction.gasPrice ?? null),
                maxFeePerGasGwei: formatOptionalGwei(
                    transaction.maxFeePerGas ?? null,
                ),
                maxPriorityFeePerGasGwei: formatOptionalGwei(
                    transaction.maxPriorityFeePerGas ?? null,
                ),
                blockNumber: transaction.blockNumber?.toString() ?? null,
                blockHash: transaction.blockHash ?? null,
            };
        } catch (error) {
            return {
                transactionLookup: "failed",
                ...toErrorLogFields(error),
            };
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
        log.info(
            "approvalReceiptWaitStarted",
            "Waiting for WETH approval receipt",
            {
                transactionHash: params.transactionHash,
                desiredAllowanceWei: params.desiredAllowanceWei.toString(),
                desiredAllowanceWeth: formatWeth(params.desiredAllowanceWei),
                previousAllowanceWei: params.currentAllowanceWei.toString(),
                previousAllowanceWeth: formatWeth(params.currentAllowanceWei),
            },
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
                    log.warn(
                        "approvalTransactionReplaced",
                        "WETH approval transaction was replaced while waiting",
                        {
                            originalTransactionHash: params.transactionHash,
                            ...formatReceiptReplacementFields(replacement),
                        },
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
        const [transactionFields, latestBlock] = await Promise.all([
            this.readBroadcastTransactionFields(params.transactionHash),
            this.readOptionalLatestBlock(),
        ]);
        log.info(
            "approvalReceiptWaitHeartbeat",
            "Still waiting for WETH approval receipt",
            {
                transactionHash: params.transactionHash,
                elapsed,
                elapsedMs,
                desiredAllowanceWei: params.desiredAllowanceWei.toString(),
                desiredAllowanceWeth: formatWeth(params.desiredAllowanceWei),
                previousAllowanceWei: params.currentAllowanceWei.toString(),
                previousAllowanceWeth: formatWeth(params.currentAllowanceWei),
                latestBlockNumber: latestBlock.number?.toString() ?? null,
                baseFeePerGasGwei: formatOptionalGwei(
                    latestBlock.baseFeePerGas,
                ),
                ...transactionFields,
            },
        );
    }
}

function formatWeth(amountWei: bigint): string {
    return `${formatEther(amountWei)} WETH`;
}

function multiplyByBpsCeil(value: bigint, basisPoints: bigint): bigint {
    return (
        (value * basisPoints + BASIS_POINTS_DENOMINATOR - 1n) /
        BASIS_POINTS_DENOMINATOR
    );
}

function formatElapsed(elapsedMs: number): string {
    return `${Math.floor(elapsedMs / 1000)}s`;
}

function formatOptionalInteger(value: bigint | number | null): string {
    return value === null ? "n/a" : value.toString();
}

function logTransactionPolicyEvent(event: EvmTransactionPolicyEvent): void {
    const action = transactionPolicyEventAction(event);
    const fields = transactionPolicyEventFields(event);
    if (
        event.type === "read_failed" ||
        event.type === "pending_nonce_detected"
    ) {
        log.warn(action, "WETH approval transaction policy warning", fields);
        return;
    }
    log.info(action, "WETH approval transaction policy event", fields);
}

function transactionPolicyEventAction(
    event: EvmTransactionPolicyEvent,
): string {
    switch (event.type) {
        case "read_started":
            return "transactionPolicyReadStarted";
        case "read_failed":
            return "transactionPolicyReadFailed";
        case "latest_block_read":
            return "transactionPolicyLatestBlockRead";
        case "fee_estimate_read":
            return "transactionPolicyFeeEstimateRead";
        case "fee_history_read":
            return "transactionPolicyFeeHistoryRead";
        case "nonce_read":
            return "transactionPolicyNonceRead";
        case "pending_nonce_detected":
            return "transactionPolicyPendingNonceDetected";
        case "fee_policy_resolved":
            return "transactionPolicyResolved";
    }
}

function transactionPolicyEventFields(
    event: EvmTransactionPolicyEvent,
): Record<string, unknown> {
    const base = {
        policyEventType: event.type,
        policyContext: event.context,
        fromAddress: event.fromAddress,
        policySummary: formatEvmTransactionPolicyEvent(event),
    };

    switch (event.type) {
        case "read_started":
            return { ...base, readAction: event.action };
        case "read_failed":
            return {
                ...base,
                readAction: event.action,
                errorMessage: event.error,
            };
        case "latest_block_read":
            return {
                ...base,
                blockNumber: event.blockNumber?.toString() ?? null,
                baseFeePerGasWei: event.baseFeePerGasWei?.toString() ?? null,
                baseFeePerGasGwei: formatOptionalGwei(event.baseFeePerGasWei),
            };
        case "fee_estimate_read":
            return {
                ...base,
                gasPriceWei: event.gasPriceWei?.toString() ?? null,
                gasPriceGwei: formatOptionalGwei(event.gasPriceWei),
                maxFeePerGasWei: event.maxFeePerGasWei?.toString() ?? null,
                maxFeePerGasGwei: formatOptionalGwei(event.maxFeePerGasWei),
                maxPriorityFeePerGasWei:
                    event.maxPriorityFeePerGasWei?.toString() ?? null,
                maxPriorityFeePerGasGwei: formatOptionalGwei(
                    event.maxPriorityFeePerGasWei,
                ),
            };
        case "fee_history_read":
            return {
                ...base,
                blockCount: event.blockCount,
                rewardPercentile: event.rewardPercentile,
                rewardSampleWei: event.rewardSamples.map((sample) =>
                    sample.toString(),
                ),
                selectedPriorityFeePerGasWei:
                    event.selectedPriorityFeePerGasWei?.toString() ?? null,
                selectedPriorityFeePerGasGwei: formatOptionalGwei(
                    event.selectedPriorityFeePerGasWei,
                ),
            };
        case "nonce_read":
            return {
                ...base,
                blockTag: event.blockTag,
                nonce: event.nonce,
            };
        case "pending_nonce_detected":
            return {
                ...base,
                latestNonce: event.latestNonce,
                pendingNonce: event.pendingNonce,
                pendingCount: event.pendingNonce - event.latestNonce,
            };
        case "fee_policy_resolved":
            return {
                ...base,
                blockNumber: event.blockNumber?.toString() ?? null,
                baseFeePerGasWei: event.baseFeePerGasWei.toString(),
                baseFeePerGasGwei: formatWeiAsGwei(event.baseFeePerGasWei),
                nodeMaxFeePerGasWei:
                    event.nodeMaxFeePerGasWei?.toString() ?? null,
                nodeMaxFeePerGasGwei: formatOptionalGwei(
                    event.nodeMaxFeePerGasWei,
                ),
                nodeMaxPriorityFeePerGasWei:
                    event.nodeMaxPriorityFeePerGasWei?.toString() ?? null,
                nodeMaxPriorityFeePerGasGwei: formatOptionalGwei(
                    event.nodeMaxPriorityFeePerGasWei,
                ),
                feeHistoryPriorityFeePerGasWei:
                    event.feeHistoryPriorityFeePerGasWei?.toString() ?? null,
                feeHistoryPriorityFeePerGasGwei: formatOptionalGwei(
                    event.feeHistoryPriorityFeePerGasWei,
                ),
                configuredMinPriorityFeePerGasWei:
                    event.configuredMinPriorityFeePerGasWei.toString(),
                configuredMinPriorityFeePerGasGwei: formatWeiAsGwei(
                    event.configuredMinPriorityFeePerGasWei,
                ),
                configuredPriorityFeeHistoryBlockCount:
                    event.configuredPriorityFeeHistoryBlockCount,
                configuredPriorityFeeHistoryRewardPercentile:
                    event.configuredPriorityFeeHistoryRewardPercentile,
                configuredBaseFeeMultiplier: formatFeeMultiplierBps(
                    event.configuredBaseFeeMultiplierBps,
                ),
                configuredMaxFeePerGasWei:
                    event.configuredMaxFeePerGasWei.toString(),
                configuredMaxFeePerGasGwei: formatWeiAsGwei(
                    event.configuredMaxFeePerGasWei,
                ),
                maxPriorityFeePerGasWei:
                    event.maxPriorityFeePerGasWei.toString(),
                maxPriorityFeePerGasGwei: formatWeiAsGwei(
                    event.maxPriorityFeePerGasWei,
                ),
                uncappedMaxFeePerGasWei:
                    event.uncappedMaxFeePerGasWei.toString(),
                uncappedMaxFeePerGasGwei: formatWeiAsGwei(
                    event.uncappedMaxFeePerGasWei,
                ),
                maxFeePerGasWei: event.maxFeePerGasWei.toString(),
                maxFeePerGasGwei: formatWeiAsGwei(event.maxFeePerGasWei),
                latestNonce: event.latestNonce,
                pendingNonce: event.pendingNonce,
            };
    }
}

function formatReceiptReplacementFields(
    replacement: unknown,
): Record<string, unknown> {
    if (!replacement || typeof replacement !== "object") {
        return { replacement: String(replacement) };
    }
    const value = replacement as {
        reason?: unknown;
        replacedTransaction?: { hash?: unknown };
        transaction?: { hash?: unknown };
        transactionReceipt?: { transactionHash?: unknown; status?: unknown };
    };
    return {
        replacementReason: value.reason ?? "unknown",
        replacedTransactionHash: value.replacedTransaction?.hash ?? null,
        replacementTransactionHash: value.transaction?.hash ?? null,
        receiptTransactionHash:
            value.transactionReceipt?.transactionHash ?? null,
        receiptStatus: value.transactionReceipt?.status ?? null,
    };
}
