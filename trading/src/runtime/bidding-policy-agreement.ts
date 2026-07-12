import type { EvmTransactionPolicyConfig } from "@artgod/shared/evm/transactions";
import type { EnabledBiddingConfig } from "../config/trading-config.js";
import { BIDDING_RUNTIME_ENV_KEY } from "../config/bidding-defaults.js";
import type { BiddingMandate } from "../domain/bidding-mandate.js";

// Rejects typed config drift before any transaction-capable runtime adapter is composed.
export function assertBiddingPolicyMatchesConfig(
    config: EnabledBiddingConfig,
    mandate: BiddingMandate,
): void {
    const policy = mandate.startPolicy;
    assertEqual(
        BIDDING_RUNTIME_ENV_KEY.WethAllowanceCapEth,
        config.wethAllowanceCapWei,
        policy.wethAllowanceCapWei,
    );
    assertEqual(
        BIDDING_RUNTIME_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers,
        config.trustOpenSeaSignedZoneTraitOffers,
        policy.trustOpenSeaSignedZoneTraitOffers,
    );
    assertEqual(
        BIDDING_RUNTIME_ENV_KEY.TxMinPriorityFeeGwei,
        config.transactionPolicy.fees.minPriorityFeePerGasWei,
        policy.wethApproval.minPriorityFeePerGasWei,
    );
    assertEqual(
        BIDDING_RUNTIME_ENV_KEY.TxMaxFeeGwei,
        config.transactionPolicy.fees.maxFeePerGasWei,
        policy.wethApproval.maxFeePerGasWei,
    );
    assertEqual(
        BIDDING_RUNTIME_ENV_KEY.WethApprovalMaxGasFeeEth,
        config.wethApprovalMaxGasFeeWei,
        policy.wethApproval.maxTotalGasFeeWei,
    );
    assertEqual(
        BIDDING_RUNTIME_ENV_KEY.TxPendingNoncePolicy,
        config.transactionPolicy.nonce.pendingNoncePolicy,
        policy.wethApproval.pendingNoncePolicy,
    );
}

// Combines mandate-owned limits with config-owned estimator tuning.
export function buildMandateApprovalTransactionPolicy(
    config: EnabledBiddingConfig,
    mandate: BiddingMandate,
): EvmTransactionPolicyConfig {
    return {
        fees: {
            minPriorityFeePerGasWei:
                mandate.startPolicy.wethApproval.minPriorityFeePerGasWei,
            maxFeePerGasWei:
                mandate.startPolicy.wethApproval.maxFeePerGasWei,
            priorityFeeHistoryBlockCount:
                config.transactionPolicy.fees
                    .priorityFeeHistoryBlockCount,
            priorityFeeHistoryRewardPercentile:
                config.transactionPolicy.fees
                    .priorityFeeHistoryRewardPercentile,
            baseFeeMultiplierBps:
                config.transactionPolicy.fees.baseFeeMultiplierBps,
        },
        nonce: {
            pendingNoncePolicy:
                mandate.startPolicy.wethApproval.pendingNoncePolicy,
        },
    };
}

function assertEqual<T extends bigint | boolean | string>(
    setting: string,
    configValue: T,
    mandateValue: T,
): void {
    if (configValue !== mandateValue) {
        throw new Error(
            `Bidding start policy does not match typed runtime config for ${setting}`,
        );
    }
}
