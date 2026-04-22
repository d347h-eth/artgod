const FEE_MULTIPLIER_BPS_DENOMINATOR = 10_000n;
const WEI_PER_GWEI = 1_000_000_000n;

export type EvmBlockTag = "latest" | "pending";
export type EvmAddress = `0x${string}`;

export type EvmFeeEstimate = {
    gasPrice?: bigint | null;
    maxFeePerGas?: bigint | null;
    maxPriorityFeePerGas?: bigint | null;
};

export type EvmFeeHistory = {
    reward?: readonly (readonly bigint[])[] | null;
};

export type EvmLatestBlock = {
    number: bigint | null;
    baseFeePerGas?: bigint | null;
};

export type EvmTransactionPolicyReader = {
    getBlock(args: { blockTag: "latest" }): Promise<EvmLatestBlock>;
    estimateFeesPerGas(): Promise<EvmFeeEstimate>;
    getTransactionCount(args: {
        address: EvmAddress;
        blockTag: EvmBlockTag;
    }): Promise<number>;
    getFeeHistory?(args: {
        blockCount: number;
        rewardPercentiles: number[];
        blockTag?: "latest";
    }): Promise<EvmFeeHistory>;
};

export type EvmTransactionFeePolicyConfig = {
    minPriorityFeePerGasWei: bigint;
    priorityFeeHistoryBlockCount: number;
    priorityFeeHistoryRewardPercentile: number;
    baseFeeMultiplierBps: bigint;
    maxFeePerGasWei: bigint;
};

export type EvmPendingNoncePolicy = "fail";

export type EvmTransactionNoncePolicyConfig = {
    pendingNoncePolicy: EvmPendingNoncePolicy;
};

export type EvmTransactionPolicyConfig = {
    fees: EvmTransactionFeePolicyConfig;
    nonce: EvmTransactionNoncePolicyConfig;
};

export type EvmTransactionPolicyReadAction =
    | "latest_block"
    | "fee_estimate"
    | "fee_history"
    | "latest_nonce"
    | "pending_nonce";

export type EvmTransactionPolicyEvent =
    | {
          type: "read_started";
          context: string;
          fromAddress: EvmAddress;
          action: EvmTransactionPolicyReadAction;
      }
    | {
          type: "read_failed";
          context: string;
          fromAddress: EvmAddress;
          action: EvmTransactionPolicyReadAction;
          error: string;
      }
    | {
          type: "latest_block_read";
          context: string;
          fromAddress: EvmAddress;
          blockNumber: bigint | null;
          baseFeePerGasWei: bigint | null;
      }
    | {
          type: "fee_estimate_read";
          context: string;
          fromAddress: EvmAddress;
          gasPriceWei: bigint | null;
          maxFeePerGasWei: bigint | null;
          maxPriorityFeePerGasWei: bigint | null;
      }
    | {
          type: "fee_history_read";
          context: string;
          fromAddress: EvmAddress;
          blockCount: number;
          rewardPercentile: number;
          rewardSamples: readonly bigint[];
          selectedPriorityFeePerGasWei: bigint | null;
      }
    | {
          type: "nonce_read";
          context: string;
          fromAddress: EvmAddress;
          blockTag: EvmBlockTag;
          nonce: number;
      }
    | {
          type: "pending_nonce_detected";
          context: string;
          fromAddress: EvmAddress;
          latestNonce: number;
          pendingNonce: number;
      }
    | {
          type: "fee_policy_resolved";
          context: string;
          fromAddress: EvmAddress;
          blockNumber: bigint | null;
          baseFeePerGasWei: bigint;
          nodeMaxFeePerGasWei: bigint | null;
          nodeMaxPriorityFeePerGasWei: bigint | null;
          feeHistoryPriorityFeePerGasWei: bigint | null;
          configuredMinPriorityFeePerGasWei: bigint;
          configuredPriorityFeeHistoryBlockCount: number;
          configuredPriorityFeeHistoryRewardPercentile: number;
          configuredBaseFeeMultiplierBps: bigint;
          configuredMaxFeePerGasWei: bigint;
          maxPriorityFeePerGasWei: bigint;
          uncappedMaxFeePerGasWei: bigint;
          maxFeePerGasWei: bigint;
          latestNonce: number;
          pendingNonce: number;
      };

export type EvmTransactionPolicyObserver = {
    onEvent?(event: EvmTransactionPolicyEvent): void;
};

export type EvmPreparedTransactionPolicy = {
    context: string;
    fromAddress: EvmAddress;
    blockNumber: bigint | null;
    baseFeePerGasWei: bigint;
    nodeGasPriceWei: bigint | null;
    nodeMaxFeePerGasWei: bigint | null;
    nodeMaxPriorityFeePerGasWei: bigint | null;
    feeHistoryPriorityFeePerGasWei: bigint | null;
    configuredMinPriorityFeePerGasWei: bigint;
    configuredPriorityFeeHistoryBlockCount: number;
    configuredPriorityFeeHistoryRewardPercentile: number;
    configuredBaseFeeMultiplierBps: bigint;
    configuredMaxFeePerGasWei: bigint;
    maxPriorityFeePerGasWei: bigint;
    uncappedMaxFeePerGasWei: bigint;
    maxFeePerGasWei: bigint;
    latestNonce: number;
    pendingNonce: number;
};

export type PrepareEvmTransactionPolicyInput = {
    context: string;
    fromAddress: EvmAddress;
};

// EvmTransactionPolicyService centralizes fee selection and nonce-safety checks for local EOA transactions.
export class EvmTransactionPolicyService {
    constructor(
        private readonly reader: EvmTransactionPolicyReader,
        private readonly config: EvmTransactionPolicyConfig,
        private readonly observer: EvmTransactionPolicyObserver = {},
    ) {
        validateTransactionPolicyConfig(config);
    }

    public async prepare(
        input: PrepareEvmTransactionPolicyInput,
    ): Promise<EvmPreparedTransactionPolicy> {
        const [
            latestBlock,
            feeEstimate,
            feeHistory,
            latestNonce,
            pendingNonce,
        ] = await Promise.all([
            this.readLatestBlock(input),
            this.readFeeEstimate(input),
            this.readFeeHistory(input),
            this.readNonce(input, "latest"),
            this.readNonce(input, "pending"),
        ]);

        if (pendingNonce > latestNonce) {
            this.emit({
                type: "pending_nonce_detected",
                context: input.context,
                fromAddress: input.fromAddress,
                latestNonce,
                pendingNonce,
            });
            throw new EvmPendingNonceQueueError({
                context: input.context,
                fromAddress: input.fromAddress,
                latestNonce,
                pendingNonce,
                pendingNoncePolicy: this.config.nonce.pendingNoncePolicy,
            });
        }

        const baseFeePerGasWei = latestBlock.baseFeePerGas ?? null;
        if (baseFeePerGasWei === null) {
            throw new Error(
                `Cannot prepare ${input.context}: latest block did not include baseFeePerGas`,
            );
        }

        const nodePriorityFeePerGasWei =
            feeEstimate.maxPriorityFeePerGas ?? null;
        const feeHistoryPriorityFeePerGasWei =
            feeHistory.selectedPriorityFeePerGasWei;
        const maxPriorityFeePerGasWei = maxBigint(
            maxBigint(
                nodePriorityFeePerGasWei ?? 0n,
                feeHistoryPriorityFeePerGasWei ?? 0n,
            ),
            this.config.fees.minPriorityFeePerGasWei,
        );
        const baseFeeWithHeadroomWei = multiplyByBpsCeil(
            baseFeePerGasWei,
            this.config.fees.baseFeeMultiplierBps,
        );
        const uncappedMaxFeePerGasWei =
            baseFeeWithHeadroomWei + maxPriorityFeePerGasWei;
        const maxFeePerGasWei = minBigint(
            uncappedMaxFeePerGasWei,
            this.config.fees.maxFeePerGasWei,
        );

        if (maxFeePerGasWei < baseFeePerGasWei + maxPriorityFeePerGasWei) {
            throw new EvmFeeCapTooLowError({
                context: input.context,
                baseFeePerGasWei,
                maxPriorityFeePerGasWei,
                maxFeePerGasWei,
                configuredMaxFeePerGasWei: this.config.fees.maxFeePerGasWei,
            });
        }

        const prepared = {
            context: input.context,
            fromAddress: input.fromAddress,
            blockNumber: latestBlock.number,
            baseFeePerGasWei,
            nodeGasPriceWei: feeEstimate.gasPrice ?? null,
            nodeMaxFeePerGasWei: feeEstimate.maxFeePerGas ?? null,
            nodeMaxPriorityFeePerGasWei: nodePriorityFeePerGasWei,
            feeHistoryPriorityFeePerGasWei,
            configuredMinPriorityFeePerGasWei:
                this.config.fees.minPriorityFeePerGasWei,
            configuredPriorityFeeHistoryBlockCount:
                this.config.fees.priorityFeeHistoryBlockCount,
            configuredPriorityFeeHistoryRewardPercentile:
                this.config.fees.priorityFeeHistoryRewardPercentile,
            configuredBaseFeeMultiplierBps:
                this.config.fees.baseFeeMultiplierBps,
            configuredMaxFeePerGasWei: this.config.fees.maxFeePerGasWei,
            maxPriorityFeePerGasWei,
            uncappedMaxFeePerGasWei,
            maxFeePerGasWei,
            latestNonce,
            pendingNonce,
        };

        this.emit({
            type: "fee_policy_resolved",
            context: input.context,
            fromAddress: input.fromAddress,
            blockNumber: prepared.blockNumber,
            baseFeePerGasWei: prepared.baseFeePerGasWei,
            nodeMaxFeePerGasWei: prepared.nodeMaxFeePerGasWei,
            nodeMaxPriorityFeePerGasWei: prepared.nodeMaxPriorityFeePerGasWei,
            feeHistoryPriorityFeePerGasWei:
                prepared.feeHistoryPriorityFeePerGasWei,
            configuredMinPriorityFeePerGasWei:
                prepared.configuredMinPriorityFeePerGasWei,
            configuredPriorityFeeHistoryBlockCount:
                prepared.configuredPriorityFeeHistoryBlockCount,
            configuredPriorityFeeHistoryRewardPercentile:
                prepared.configuredPriorityFeeHistoryRewardPercentile,
            configuredBaseFeeMultiplierBps:
                prepared.configuredBaseFeeMultiplierBps,
            configuredMaxFeePerGasWei: prepared.configuredMaxFeePerGasWei,
            maxPriorityFeePerGasWei: prepared.maxPriorityFeePerGasWei,
            uncappedMaxFeePerGasWei: prepared.uncappedMaxFeePerGasWei,
            maxFeePerGasWei: prepared.maxFeePerGasWei,
            latestNonce: prepared.latestNonce,
            pendingNonce: prepared.pendingNonce,
        });

        return prepared;
    }

    private async readLatestBlock(
        input: PrepareEvmTransactionPolicyInput,
    ): Promise<{ number: bigint | null; baseFeePerGas: bigint | null }> {
        this.emitReadStarted(input, "latest_block");
        try {
            // Read the latest block to anchor EIP-1559 max-fee calculation to the current base fee.
            const block = await this.reader.getBlock({ blockTag: "latest" });
            const normalized = {
                number: block.number,
                baseFeePerGas: block.baseFeePerGas ?? null,
            };
            this.emit({
                type: "latest_block_read",
                context: input.context,
                fromAddress: input.fromAddress,
                blockNumber: normalized.number,
                baseFeePerGasWei: normalized.baseFeePerGas,
            });
            return normalized;
        } catch (error) {
            this.emitReadFailed(input, "latest_block", error);
            throw error;
        }
    }

    private async readFeeEstimate(
        input: PrepareEvmTransactionPolicyInput,
    ): Promise<RequiredNullable<EvmFeeEstimate>> {
        this.emitReadStarted(input, "fee_estimate");
        try {
            // Ask the node for its current fee suggestion before applying ArtGod's configured floors and caps.
            const feeEstimate = await this.reader.estimateFeesPerGas();
            const normalized = {
                gasPrice: feeEstimate.gasPrice ?? null,
                maxFeePerGas: feeEstimate.maxFeePerGas ?? null,
                maxPriorityFeePerGas: feeEstimate.maxPriorityFeePerGas ?? null,
            };
            this.emit({
                type: "fee_estimate_read",
                context: input.context,
                fromAddress: input.fromAddress,
                gasPriceWei: normalized.gasPrice,
                maxFeePerGasWei: normalized.maxFeePerGas,
                maxPriorityFeePerGasWei: normalized.maxPriorityFeePerGas,
            });
            return normalized;
        } catch (error) {
            this.emitReadFailed(input, "fee_estimate", error);
            throw error;
        }
    }

    private async readFeeHistory(
        input: PrepareEvmTransactionPolicyInput,
    ): Promise<{ selectedPriorityFeePerGasWei: bigint | null }> {
        const blockCount = this.config.fees.priorityFeeHistoryBlockCount;
        const rewardPercentile =
            this.config.fees.priorityFeeHistoryRewardPercentile;
        if (!this.reader.getFeeHistory) {
            return { selectedPriorityFeePerGasWei: null };
        }

        this.emitReadStarted(input, "fee_history");
        try {
            // Read recent effective priority-fee percentiles because some nodes can report a zero tip suggestion.
            const feeHistory = await this.reader.getFeeHistory({
                blockCount,
                rewardPercentiles: [rewardPercentile],
                blockTag: "latest",
            });
            const rewardSamples = collectFeeHistoryRewardSamples(
                feeHistory.reward ?? null,
            );
            const selectedPriorityFeePerGasWei =
                selectFeeHistoryPriorityFee(rewardSamples);
            this.emit({
                type: "fee_history_read",
                context: input.context,
                fromAddress: input.fromAddress,
                blockCount,
                rewardPercentile,
                rewardSamples,
                selectedPriorityFeePerGasWei,
            });
            return { selectedPriorityFeePerGasWei };
        } catch (error) {
            this.emitReadFailed(input, "fee_history", error);
            return { selectedPriorityFeePerGasWei: null };
        }
    }

    private async readNonce(
        input: PrepareEvmTransactionPolicyInput,
        blockTag: EvmBlockTag,
    ): Promise<number> {
        const action = blockTag === "latest" ? "latest_nonce" : "pending_nonce";
        this.emitReadStarted(input, action);
        try {
            // Compare latest and pending nonces so the bot does not blindly stack transactions behind a stuck nonce.
            const nonce = await this.reader.getTransactionCount({
                address: input.fromAddress,
                blockTag,
            });
            this.emit({
                type: "nonce_read",
                context: input.context,
                fromAddress: input.fromAddress,
                blockTag,
                nonce,
            });
            return nonce;
        } catch (error) {
            this.emitReadFailed(input, action, error);
            throw error;
        }
    }

    private emitReadStarted(
        input: PrepareEvmTransactionPolicyInput,
        action: EvmTransactionPolicyReadAction,
    ): void {
        this.emit({
            type: "read_started",
            context: input.context,
            fromAddress: input.fromAddress,
            action,
        });
    }

    private emitReadFailed(
        input: PrepareEvmTransactionPolicyInput,
        action: EvmTransactionPolicyReadAction,
        error: unknown,
    ): void {
        this.emit({
            type: "read_failed",
            context: input.context,
            fromAddress: input.fromAddress,
            action,
            error: formatError(error),
        });
    }

    private emit(event: EvmTransactionPolicyEvent): void {
        this.observer.onEvent?.(event);
    }
}

// EvmPendingNonceQueueError reports a blocked sender account before submitting another transaction.
export class EvmPendingNonceQueueError extends Error {
    public readonly context: string;
    public readonly fromAddress: EvmAddress;
    public readonly latestNonce: number;
    public readonly pendingNonce: number;
    public readonly pendingNoncePolicy: EvmPendingNoncePolicy;

    constructor(params: {
        context: string;
        fromAddress: EvmAddress;
        latestNonce: number;
        pendingNonce: number;
        pendingNoncePolicy: EvmPendingNoncePolicy;
    }) {
        super(
            `Cannot submit ${params.context}: pending nonce queue detected for ${params.fromAddress}. latestNonce=${params.latestNonce}, pendingNonce=${params.pendingNonce}, pendingCount=${params.pendingNonce - params.latestNonce}, pendingNoncePolicy=${params.pendingNoncePolicy}`,
        );
        this.name = "EvmPendingNonceQueueError";
        this.context = params.context;
        this.fromAddress = params.fromAddress;
        this.latestNonce = params.latestNonce;
        this.pendingNonce = params.pendingNonce;
        this.pendingNoncePolicy = params.pendingNoncePolicy;
    }
}

// EvmFeeCapTooLowError reports a configured fee cap that would undercut the selected tip floor.
export class EvmFeeCapTooLowError extends Error {
    public readonly context: string;
    public readonly baseFeePerGasWei: bigint;
    public readonly maxPriorityFeePerGasWei: bigint;
    public readonly maxFeePerGasWei: bigint;
    public readonly configuredMaxFeePerGasWei: bigint;

    constructor(params: {
        context: string;
        baseFeePerGasWei: bigint;
        maxPriorityFeePerGasWei: bigint;
        maxFeePerGasWei: bigint;
        configuredMaxFeePerGasWei: bigint;
    }) {
        super(
            `Cannot submit ${params.context}: configured max fee cap is below the current base fee plus selected priority fee. baseFee=${formatWeiAsGwei(params.baseFeePerGasWei)}, priorityFee=${formatWeiAsGwei(params.maxPriorityFeePerGasWei)}, selectedMaxFee=${formatWeiAsGwei(params.maxFeePerGasWei)}, configuredMaxFeeCap=${formatWeiAsGwei(params.configuredMaxFeePerGasWei)}`,
        );
        this.name = "EvmFeeCapTooLowError";
        this.context = params.context;
        this.baseFeePerGasWei = params.baseFeePerGasWei;
        this.maxPriorityFeePerGasWei = params.maxPriorityFeePerGasWei;
        this.maxFeePerGasWei = params.maxFeePerGasWei;
        this.configuredMaxFeePerGasWei = params.configuredMaxFeePerGasWei;
    }
}

// formatEvmTransactionPolicyEvent renders policy events for adapter-local logs.
export function formatEvmTransactionPolicyEvent(
    event: EvmTransactionPolicyEvent,
): string {
    switch (event.type) {
        case "read_started":
            return `Reading ${formatReadAction(event.action)} from node. context=${event.context}, from=${event.fromAddress}`;
        case "read_failed":
            return `Failed to read ${formatReadAction(event.action)} from node. context=${event.context}, from=${event.fromAddress}, error=${event.error}`;
        case "latest_block_read":
            return `Latest block fee data read. context=${event.context}, block=${formatOptionalInteger(event.blockNumber)}, baseFee=${formatOptionalGwei(event.baseFeePerGasWei)}`;
        case "fee_estimate_read":
            return `Node fee estimate read. context=${event.context}, gasPrice=${formatOptionalGwei(event.gasPriceWei)}, maxFeePerGas=${formatOptionalGwei(event.maxFeePerGasWei)}, maxPriorityFeePerGas=${formatOptionalGwei(event.maxPriorityFeePerGasWei)}`;
        case "fee_history_read":
            return `Fee history priority-fee data read. context=${event.context}, blockCount=${event.blockCount}, rewardPercentile=${event.rewardPercentile}, rewardSamples=${formatRewardSamples(event.rewardSamples)}, selectedPriorityFeePerGas=${formatOptionalGwei(event.selectedPriorityFeePerGasWei)}`;
        case "nonce_read":
            return `Nonce read from node. context=${event.context}, from=${event.fromAddress}, blockTag=${event.blockTag}, nonce=${event.nonce}`;
        case "pending_nonce_detected":
            return `Pending nonce queue detected. context=${event.context}, from=${event.fromAddress}, latestNonce=${event.latestNonce}, pendingNonce=${event.pendingNonce}, pendingCount=${event.pendingNonce - event.latestNonce}`;
        case "fee_policy_resolved":
            return `Transaction fee policy resolved. context=${event.context}, block=${formatOptionalInteger(event.blockNumber)}, baseFee=${formatWeiAsGwei(event.baseFeePerGasWei)}, nodeMaxFeePerGas=${formatOptionalGwei(event.nodeMaxFeePerGasWei)}, nodeMaxPriorityFeePerGas=${formatOptionalGwei(event.nodeMaxPriorityFeePerGasWei)}, feeHistoryPriorityFeePerGas=${formatOptionalGwei(event.feeHistoryPriorityFeePerGasWei)}, configuredMinPriorityFee=${formatWeiAsGwei(event.configuredMinPriorityFeePerGasWei)}, configuredFeeHistoryBlockCount=${event.configuredPriorityFeeHistoryBlockCount}, configuredFeeHistoryRewardPercentile=${event.configuredPriorityFeeHistoryRewardPercentile}, configuredBaseFeeMultiplier=${formatFeeMultiplierBps(event.configuredBaseFeeMultiplierBps)}, configuredMaxFeeCap=${formatWeiAsGwei(event.configuredMaxFeePerGasWei)}, selectedMaxPriorityFeePerGas=${formatWeiAsGwei(event.maxPriorityFeePerGasWei)}, uncappedMaxFeePerGas=${formatWeiAsGwei(event.uncappedMaxFeePerGasWei)}, selectedMaxFeePerGas=${formatWeiAsGwei(event.maxFeePerGasWei)}, latestNonce=${event.latestNonce}, pendingNonce=${event.pendingNonce}`;
    }
}

// formatOptionalGwei renders nullable wei-denominated gas values in human-readable gwei.
export function formatOptionalGwei(value: bigint | null): string {
    return value === null ? "n/a" : formatWeiAsGwei(value);
}

// formatWeiAsGwei renders wei-denominated gas values in human-readable gwei.
export function formatWeiAsGwei(valueWei: bigint): string {
    return `${formatDecimal(valueWei, WEI_PER_GWEI)} gwei`;
}

// formatFeeMultiplierBps renders basis-point multipliers as decimal x values.
export function formatFeeMultiplierBps(multiplierBps: bigint): string {
    return `${formatDecimal(multiplierBps, FEE_MULTIPLIER_BPS_DENOMINATOR)}x`;
}

function validateTransactionPolicyConfig(
    config: EvmTransactionPolicyConfig,
): void {
    if (config.fees.minPriorityFeePerGasWei <= 0n) {
        throw new Error("minPriorityFeePerGasWei must be positive");
    }
    if (
        !Number.isInteger(config.fees.priorityFeeHistoryBlockCount) ||
        config.fees.priorityFeeHistoryBlockCount <= 0 ||
        config.fees.priorityFeeHistoryBlockCount > 1024
    ) {
        throw new Error(
            "priorityFeeHistoryBlockCount must be an integer between 1 and 1024",
        );
    }
    if (
        !Number.isFinite(config.fees.priorityFeeHistoryRewardPercentile) ||
        config.fees.priorityFeeHistoryRewardPercentile <= 0 ||
        config.fees.priorityFeeHistoryRewardPercentile > 100
    ) {
        throw new Error(
            "priorityFeeHistoryRewardPercentile must be greater than 0 and less than or equal to 100",
        );
    }
    if (config.fees.baseFeeMultiplierBps < FEE_MULTIPLIER_BPS_DENOMINATOR) {
        throw new Error("baseFeeMultiplierBps must be at least 10000");
    }
    if (config.fees.maxFeePerGasWei <= 0n) {
        throw new Error("maxFeePerGasWei must be positive");
    }
    if (config.fees.maxFeePerGasWei < config.fees.minPriorityFeePerGasWei) {
        throw new Error(
            "maxFeePerGasWei must be greater than or equal to minPriorityFeePerGasWei",
        );
    }
    if (config.nonce.pendingNoncePolicy !== "fail") {
        throw new Error(
            `Unsupported pending nonce policy: ${config.nonce.pendingNoncePolicy}`,
        );
    }
}

function multiplyByBpsCeil(value: bigint, multiplierBps: bigint): bigint {
    const scaled = value * multiplierBps;
    return (
        scaled / FEE_MULTIPLIER_BPS_DENOMINATOR +
        (scaled % FEE_MULTIPLIER_BPS_DENOMINATOR === 0n ? 0n : 1n)
    );
}

function minBigint(left: bigint, right: bigint): bigint {
    return left < right ? left : right;
}

function maxBigint(left: bigint, right: bigint): bigint {
    return left > right ? left : right;
}

function formatReadAction(action: EvmTransactionPolicyReadAction): string {
    switch (action) {
        case "latest_block":
            return "latest block fee data";
        case "fee_estimate":
            return "fee estimate";
        case "fee_history":
            return "fee history";
        case "latest_nonce":
            return "latest nonce";
        case "pending_nonce":
            return "pending nonce";
    }
}

function collectFeeHistoryRewardSamples(
    reward: readonly (readonly bigint[])[] | null,
): readonly bigint[] {
    if (!reward) {
        return [];
    }
    return reward
        .map((blockRewards) => blockRewards[0] ?? null)
        .filter((value): value is bigint => value !== null && value > 0n);
}

function selectFeeHistoryPriorityFee(
    rewardSamples: readonly bigint[],
): bigint | null {
    if (rewardSamples.length === 0) {
        return null;
    }
    return rewardSamples.reduce((max, value) => (value > max ? value : max));
}

function formatRewardSamples(rewardSamples: readonly bigint[]): string {
    if (rewardSamples.length === 0) {
        return "[]";
    }
    return `[${rewardSamples.map(formatWeiAsGwei).join(", ")}]`;
}

function formatOptionalInteger(value: bigint | number | null): string {
    return value === null ? "n/a" : value.toString();
}

function formatDecimal(value: bigint, denominator: bigint): string {
    const whole = value / denominator;
    const fraction = value % denominator;
    if (fraction === 0n) {
        return whole.toString();
    }
    const fractionWidth = denominator.toString().length - 1;
    const fractionText = fraction
        .toString()
        .padStart(fractionWidth, "0")
        .replace(/0+$/, "");
    return `${whole.toString()}.${fractionText}`;
}

function formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    return String(error);
}

type RequiredNullable<T> = {
    [K in keyof T]-?: NonNullable<T[K]> | null;
};
