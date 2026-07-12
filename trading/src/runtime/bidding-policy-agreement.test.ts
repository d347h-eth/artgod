import { describe, expect, it } from "vitest";
import { BiddingMandate } from "../domain/bidding-mandate.js";
import type { EnabledBiddingConfig } from "../config/trading-config.js";
import {
    assertBiddingPolicyMatchesConfig,
    buildMandateApprovalTransactionPolicy,
} from "./bidding-policy-agreement.js";

describe("bidding policy agreement", () => {
    it("accepts exact typed agreement and keeps estimator tuning outside the mandate", () => {
        const config = biddingConfig();
        const mandate = biddingMandate();

        expect(() =>
            assertBiddingPolicyMatchesConfig(config, mandate),
        ).not.toThrow();
        expect(buildMandateApprovalTransactionPolicy(config, mandate)).toEqual(
            config.transactionPolicy,
        );
    });

    it.each([
        ["allowance", (config: EnabledBiddingConfig) => (config.wethAllowanceCapWei = 101n)],
        ["trait trust", (config: EnabledBiddingConfig) => (config.trustOpenSeaSignedZoneTraitOffers = false)],
        [
            "minimum priority fee",
            (config: EnabledBiddingConfig) =>
                (config.transactionPolicy.fees.minPriorityFeePerGasWei = 2n),
        ],
        [
            "maximum fee per gas",
            (config: EnabledBiddingConfig) =>
                (config.transactionPolicy.fees.maxFeePerGasWei = 11n),
        ],
        ["maximum total fee", (config: EnabledBiddingConfig) => (config.wethApprovalMaxGasFeeWei = 1001n)],
    ])("rejects %s drift", (_label, mutate) => {
        const config = biddingConfig();
        mutate(config);

        expect(() =>
            assertBiddingPolicyMatchesConfig(config, biddingMandate()),
        ).toThrow("does not match typed runtime config");
    });
});

function biddingMandate(): BiddingMandate {
    return BiddingMandate.parse(
        {
            chainId: 1,
            startPolicy: {
                wethAllowanceCapWei: "100",
                trustOpenSeaSignedZoneTraitOffers: true,
                wethApproval: {
                    minPriorityFeePerGasWei: "1",
                    maxFeePerGasWei: "10",
                    maxTotalGasFeeWei: "1000",
                    pendingNoncePolicy: "fail",
                },
            },
            collections: [
                {
                    collectionId: 7,
                    artgodSlug: "example",
                    contractAddress:
                        "0x1111111111111111111111111111111111111111",
                    openseaSlug: "example-opensea",
                    maxUnitBidWei: "100",
                    maxQuantity: 1,
                },
            ],
        },
        1,
    );
}

function biddingConfig(): EnabledBiddingConfig {
    return {
        enabled: true,
        wethAllowanceCapWei: 100n,
        wethApprovalMaxGasFeeWei: 1000n,
        trustOpenSeaSignedZoneTraitOffers: true,
        transactionPolicy: {
            fees: {
                minPriorityFeePerGasWei: 1n,
                maxFeePerGasWei: 10n,
                priorityFeeHistoryBlockCount: 20,
                priorityFeeHistoryRewardPercentile: 70,
                baseFeeMultiplierBps: 12_500n,
            },
            nonce: { pendingNoncePolicy: "fail" },
        },
    } as EnabledBiddingConfig;
}
