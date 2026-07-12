import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { parseEther } from "viem";
import {
    getDefaultRpcEndpointResilienceConfig,
    getDefaultRpcRetryPolicy,
    RPC_RESILIENCE_ENV_KEY,
} from "@artgod/shared/config/rpc-resilience";
import {
    getDefaultOpenSeaHttpConfig,
    OPENSEA_HTTP_ENV_KEY,
} from "@artgod/shared/config/opensea-http";
import { BIDDING_CONFIG_ENV_KEY } from "@artgod/shared/config/bidding";
import { RPC_ENDPOINT_LIST_ENV_KEY } from "@artgod/shared/config/rpc-endpoints";
import {
    BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS,
    BIDDING_DEFAULT_WETH_APPROVAL_MAX_GAS_FEE_ETH,
    BIDDING_RUNTIME_ENV_KEY,
} from "./bidding-defaults.js";
import {
    loadTradingConfig,
    TRADING_METRICS_ENV_KEY,
} from "./trading-config.js";

const requiredBaseEnv = {
    ARTGOD_DB_PATH: "database/sqlite/main/db",
    CHAIN_ID: "1",
    [RPC_ENDPOINT_LIST_ENV_KEY]:
        '[{"url":"http://127.0.0.1:42721","weight":1}]',
    NATS_URL: "nats://127.0.0.1:42720",
    NATS_STREAM_PREFIX: "artgod",
    WETH_ADDRESS: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
} satisfies Record<string, string>;

const TEST_RPC_REQUEST_TIMEOUT_MS = 2_500;
const TEST_RPC_ENDPOINT_A = "https://rpc-a.example";
const TEST_RPC_ENDPOINT_B = "https://rpc-b.example";
const TEST_WEIGHTED_RPC_ENDPOINTS_JSON = JSON.stringify([
    { url: TEST_RPC_ENDPOINT_A, weight: 3 },
    { url: TEST_RPC_ENDPOINT_B, weight: 1 },
]);

describe("bidding runtime env key ownership", () => {
    it("uses the shared offer expiration key", () => {
        assert.equal(
            BIDDING_RUNTIME_ENV_KEY.OfferExpirationSeconds,
            BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds,
        );
    });
});

describe("loadTradingConfig", () => {
    it("loads enabled bidding config with defaults", () => {
        const config = loadTradingConfig(
            {
                ...requiredBaseEnv,
                BIDDING_ENABLED: "true",
                OPENSEA_STREAM_SECRET_KEY: "stream-key",
                OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
            },
            {
                envFilePath: "/tmp/artgod/runtime.env",
            },
        );

        assert.equal(config.chainId, 1);
        assert.deepEqual(config.rpc.endpoints, [
            { url: "http://127.0.0.1:42721", weight: 1 },
        ]);
        assert.deepEqual(
            config.rpc.resilience,
            getDefaultRpcEndpointResilienceConfig(),
        );
        assert.deepEqual(config.rpc.retryPolicy, getDefaultRpcRetryPolicy());
        assert.deepEqual(config.metrics, {
            enabled: false,
            host: "0.0.0.0",
            ports: {
                biddingBot: 42753,
            },
        });
        assert.equal(config.queue.natsUrl, "nats://127.0.0.1:42720");
        assert.equal(config.queue.streamPrefix, "artgod");
        assert.equal(
            config.tokens.wethAddress,
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        );
        assert.equal(config.bidding.enabled, true);
        if (!config.bidding.enabled) {
            throw new Error("Expected bidding to be enabled");
        }
        assert.equal(config.bidding.scanSleepMs, 60 * 1000);
        assert.equal(config.bidding.commandPollMs, 1_000);
        assert.equal(config.bidding.hotRefreshBroadCooldownMs, 15_000);
        assert.equal(config.bidding.hotRefreshBroadMaxPendingSignatures, 256);
        assert.equal(config.bidding.hotRefreshItemCooldownMs, 2_000);
        assert.equal(config.bidding.hotRefreshItemMaxPendingSignatures, 512);
        assert.equal(config.bidding.competitiveTraitMaxLookupSelectors, 64);
        assert.equal(config.bidding.bidBookProjectionThrottleMs, 15_000);
        assert.equal(config.bidding.commandBatchSize, 20);
        assert.equal(config.bidding.commandMaxAttempts, 5);
        assert.equal(config.bidding.commandClaimTimeoutMs, 300_000);
        assert.equal(config.bidding.failedCancellationReconcileMs, 60_000);
        assert.equal(config.bidding.cancellationRemediationRetryMs, 300_000);
        assert.equal(
            config.bidding.offerExpirationSeconds,
            BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS,
        );
        assert.equal(config.bidding.trustOpenSeaSignedZoneTraitOffers, false);
        assert.equal(config.bidding.wethAllowanceCapWei, 0n);
        assert.equal(
            config.bidding.wethApprovalMaxGasFeeWei,
            parseEther(BIDDING_DEFAULT_WETH_APPROVAL_MAX_GAS_FEE_ETH),
        );
        assert.deepEqual(config.bidding.transactionPolicy, {
            fees: {
                minPriorityFeePerGasWei: 100_000_000n,
                priorityFeeHistoryBlockCount: 20,
                priorityFeeHistoryRewardPercentile: 70,
                baseFeeMultiplierBps: 12_500n,
                maxFeePerGasWei: 10_000_000_000n,
            },
            nonce: {
                pendingNoncePolicy: "fail",
            },
        });
        assert.equal(config.bidding.openSea.streamSecretKey, "stream-key");
        assert.deepEqual(
            config.bidding.openSea.http,
            getDefaultOpenSeaHttpConfig(),
        );
        assert.deepEqual(config.bidding.criteriaRefreshTraitsByCollection, {});
        assert.deepEqual(config.bidding.tokenCriteriaTraitsByCollection, {});
    });

    it("parses weighted RPC endpoint pools", () => {
        const config = loadTradingConfig(
            {
                ...requiredBaseEnv,
                [RPC_ENDPOINT_LIST_ENV_KEY]: TEST_WEIGHTED_RPC_ENDPOINTS_JSON,
                [RPC_RESILIENCE_ENV_KEY.HttpRequestTimeoutMs]: String(
                    TEST_RPC_REQUEST_TIMEOUT_MS,
                ),
                BIDDING_ENABLED: "false",
            },
            {
                envFilePath: "/tmp/artgod/runtime.env",
            },
        );

        assert.deepEqual(config.rpc.endpoints, [
            { url: TEST_RPC_ENDPOINT_A, weight: 3 },
            { url: TEST_RPC_ENDPOINT_B, weight: 1 },
        ]);
        assert.equal(
            config.rpc.resilience.requestTimeoutMs,
            TEST_RPC_REQUEST_TIMEOUT_MS,
        );
    });

    it("parses trading metrics endpoint config", () => {
        const config = loadTradingConfig(
            {
                ...requiredBaseEnv,
                BIDDING_ENABLED: "false",
                [TRADING_METRICS_ENV_KEY.Enabled]: "true",
                [TRADING_METRICS_ENV_KEY.Host]: "127.0.0.1",
                [TRADING_METRICS_ENV_KEY.PortBiddingBot]: "49001",
            },
            {
                envFilePath: "/tmp/artgod/runtime.env",
            },
        );

        assert.deepEqual(config.metrics, {
            enabled: true,
            host: "127.0.0.1",
            ports: {
                biddingBot: 49001,
            },
        });
    });

    it("does not require bot keys or jobs file when bidding is disabled", () => {
        const config = loadTradingConfig(
            {
                ...requiredBaseEnv,
                BIDDING_ENABLED: "false",
            },
            {
                envFilePath: "/tmp/artgod/runtime.env",
            },
        );

        assert.equal(config.bidding.enabled, false);
    });

    it("allows OpenSea lane keys to share the same value", () => {
        const config = loadTradingConfig(
            {
                ...requiredBaseEnv,
                BIDDING_ENABLED: "true",
                OPENSEA_STREAM_SECRET_KEY: "shared-key",
                OPENSEA_BIDDING_SECRET_KEY: "shared-key",
                OPENSEA_SNAPSHOT_SECRET_KEY: "shared-key",
            },
            {
                envFilePath: "/tmp/artgod/runtime.env",
            },
        );

        if (!config.bidding.enabled) {
            throw new Error("Expected bidding to be enabled");
        }
        assert.equal(config.bidding.openSea.streamSecretKey, "shared-key");
        assert.equal(config.bidding.openSea.biddingSecretKey, "shared-key");
        assert.equal(config.bidding.openSea.snapshotSecretKey, "shared-key");
    });

    it("parses OpenSea HTTP settings for the bidding runtime", () => {
        const config = loadTradingConfig(
            {
                ...requiredBaseEnv,
                BIDDING_ENABLED: "true",
                OPENSEA_STREAM_SECRET_KEY: "stream-key",
                OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                [OPENSEA_HTTP_ENV_KEY.RetryMaxAttempts]: "4",
                [OPENSEA_HTTP_ENV_KEY.RetryBaseDelayMs]: "125",
                [OPENSEA_HTTP_ENV_KEY.RetryMaxDelayMs]: "900",
                [OPENSEA_HTTP_ENV_KEY.RetryJitterRatio]: "0.1",
                [OPENSEA_HTTP_ENV_KEY.RateLimitGetMax]: "7",
                [OPENSEA_HTTP_ENV_KEY.RateLimitGetRefillPerSecond]: "2.5",
                [OPENSEA_HTTP_ENV_KEY.RateLimitPostMax]: "3",
                [OPENSEA_HTTP_ENV_KEY.RateLimitPostRefillPerSecond]: "0.75",
            },
            {
                envFilePath: "/tmp/artgod/runtime.env",
            },
        );

        if (!config.bidding.enabled) {
            throw new Error("Expected bidding to be enabled");
        }

        assert.deepEqual(config.bidding.openSea.http, {
            retryPolicy: {
                maxAttempts: 4,
                baseDelayMs: 125,
                maxDelayMs: 900,
                jitterRatio: 0.1,
            },
            rateLimiter: {
                getMax: 7,
                getRefillPerSecond: 2.5,
                postMax: 3,
                postRefillPerSecond: 0.75,
            },
        });
    });

    it("parses explicit trait map overrides", () => {
        const config = loadTradingConfig(
            {
                ...requiredBaseEnv,
                BIDDING_ENABLED: "true",
                OPENSEA_STREAM_SECRET_KEY: "stream-key",
                OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                [BIDDING_CONFIG_ENV_KEY.TrustOpenSeaSignedZoneTraitOffers]:
                    "true",
                [BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth]: "2.5",
                [BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei]: "0.25",
                BIDDING_TX_FEE_HISTORY_BLOCKS: "12",
                BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE: "80",
                BIDDING_TX_BASE_FEE_MULTIPLIER: "1.5",
                [BIDDING_CONFIG_ENV_KEY.TxMaxFeeGwei]: "120",
                [BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth]: "0.02",
                [BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds]: "7200",
                BIDDING_HOT_REFRESH_BROAD_COOLDOWN_MS: "25000",
                BIDDING_HOT_REFRESH_ITEM_COOLDOWN_MS: "3000",
                BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS: "30000",
                BIDDING_FAILED_CANCELLATION_RECONCILE_MS: "45000",
                BIDDING_CANCELLATION_REMEDIATION_RETRY_MS: "240000",
                [BIDDING_CONFIG_ENV_KEY.RuntimeHeartbeatIntervalMs]: "8000",
                [BIDDING_CONFIG_ENV_KEY.RuntimeHeartbeatStaleMs]: "24000",
                BIDDING_CRITERIA_REFRESH_TRAITS_BY_COLLECTION:
                    '{"terraforms":["Zone","Biome"],"other":["Rarity"]}',
                BIDDING_TOKEN_CRITERIA_TRAITS_BY_COLLECTION:
                    '{"terraforms":["Zone","Biome","Mode"]}',
            },
            {
                envFilePath: "/tmp/artgod/runtime.env",
            },
        );

        if (!config.bidding.enabled) {
            throw new Error("Expected bidding to be enabled");
        }

        assert.deepEqual(config.bidding.criteriaRefreshTraitsByCollection, {
            terraforms: ["Zone", "Biome"],
            other: ["Rarity"],
        });
        assert.deepEqual(config.bidding.tokenCriteriaTraitsByCollection, {
            terraforms: ["Zone", "Biome", "Mode"],
        });
        assert.equal(config.bidding.trustOpenSeaSignedZoneTraitOffers, true);
        assert.equal(config.bidding.wethAllowanceCapWei, parseEther("2.5"));
        assert.equal(config.bidding.offerExpirationSeconds, 7200);
        assert.equal(
            config.bidding.wethApprovalMaxGasFeeWei,
            parseEther("0.02"),
        );
        assert.equal(config.bidding.hotRefreshBroadCooldownMs, 25_000);
        assert.equal(config.bidding.hotRefreshItemCooldownMs, 3_000);
        assert.equal(config.bidding.bidBookProjectionThrottleMs, 30_000);
        assert.equal(config.bidding.failedCancellationReconcileMs, 45_000);
        assert.equal(config.bidding.cancellationRemediationRetryMs, 240_000);
        assert.deepEqual(config.bidding.runtimeHeartbeat, {
            intervalMs: 8000,
            staleMs: 24000,
        });
        assert.equal(
            config.bidding.transactionPolicy.fees.minPriorityFeePerGasWei,
            250_000_000n,
        );
        assert.equal(
            config.bidding.transactionPolicy.fees.baseFeeMultiplierBps,
            15_000n,
        );
        assert.equal(
            config.bidding.transactionPolicy.fees.priorityFeeHistoryBlockCount,
            12,
        );
        assert.equal(
            config.bidding.transactionPolicy.fees
                .priorityFeeHistoryRewardPercentile,
            80,
        );
        assert.equal(
            config.bidding.transactionPolicy.fees.maxFeePerGasWei,
            120_000_000_000n,
        );
    });

    it("rejects invalid WETH allowance values", () => {
        assert.throws(
            () =>
                loadTradingConfig(
                    {
                        ...requiredBaseEnv,
                        BIDDING_ENABLED: "true",
                        OPENSEA_STREAM_SECRET_KEY: "stream-key",
                        OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                        OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                        [BIDDING_CONFIG_ENV_KEY.WethAllowanceCapEth]:
                            "not-ether",
                    },
                    {
                        envFilePath: "/tmp/artgod/runtime.env",
                    },
                ),
            /Invalid BIDDING_WETH_ALLOWANCE_ETH/,
        );
    });

    it("rejects a zero maximum approval gas fee", () => {
        assert.throws(
            () =>
                loadTradingConfig(
                    {
                        ...requiredBaseEnv,
                        BIDDING_ENABLED: "true",
                        OPENSEA_STREAM_SECRET_KEY: "stream-key",
                        OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                        OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                        [BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth]: "0",
                    },
                    {
                        envFilePath: "/tmp/artgod/runtime.env",
                    },
                ),
            new RegExp(`Invalid ${BIDDING_CONFIG_ENV_KEY.WethApprovalMaxGasFeeEth}`),
        );
    });

    it("rejects an invalid offer expiration through the shared key", () => {
        assert.throws(
            () =>
                loadTradingConfig(
                    {
                        ...requiredBaseEnv,
                        BIDDING_ENABLED: "true",
                        OPENSEA_STREAM_SECRET_KEY: "stream-key",
                        OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                        OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                        [BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds]: "0",
                    },
                    {
                        envFilePath: "/tmp/artgod/runtime.env",
                    },
                ),
            new RegExp(
                `Invalid ${BIDDING_CONFIG_ENV_KEY.OfferExpirationSeconds}`,
            ),
        );
    });

    it("rejects invalid transaction fee policy values", () => {
        assert.throws(
            () =>
                loadTradingConfig(
                    {
                        ...requiredBaseEnv,
                        BIDDING_ENABLED: "true",
                        OPENSEA_STREAM_SECRET_KEY: "stream-key",
                        OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                        OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                        [BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei]: "0",
                    },
                    {
                        envFilePath: "/tmp/artgod/runtime.env",
                    },
                ),
            new RegExp(`Invalid ${BIDDING_CONFIG_ENV_KEY.TxMinPriorityFeeGwei}`),
        );

        assert.throws(
            () =>
                loadTradingConfig(
                    {
                        ...requiredBaseEnv,
                        BIDDING_ENABLED: "true",
                        OPENSEA_STREAM_SECRET_KEY: "stream-key",
                        OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                        OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                        BIDDING_TX_BASE_FEE_MULTIPLIER: "0.99",
                    },
                    {
                        envFilePath: "/tmp/artgod/runtime.env",
                    },
                ),
            /Invalid BIDDING_TX_BASE_FEE_MULTIPLIER/,
        );

        assert.throws(
            () =>
                loadTradingConfig(
                    {
                        ...requiredBaseEnv,
                        BIDDING_ENABLED: "true",
                        OPENSEA_STREAM_SECRET_KEY: "stream-key",
                        OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                        OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                        BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE: "101",
                    },
                    {
                        envFilePath: "/tmp/artgod/runtime.env",
                    },
                ),
            /Invalid BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE/,
        );
    });
});
