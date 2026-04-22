import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { parseEther } from "viem";
import { loadTradingConfig } from "./trading-config.js";

const requiredBaseEnv = {
    ARTGOD_DB_PATH: "database/sqlite/main/db",
    CHAIN_ID: "1",
    RPC_URL: "http://127.0.0.1:8545",
    WETH_ADDRESS: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
} satisfies Record<string, string>;

describe("loadTradingConfig", () => {
    it("loads enabled bidding config with defaults and resolves jobs file relative to the env file", () => {
        const config = loadTradingConfig(
            {
                ...requiredBaseEnv,
                BIDDING_ENABLED: "true",
                BIDDING_JOBS_FILE: "./jobs/bidding.json",
                OPENSEA_STREAM_SECRET_KEY: "stream-key",
                OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
            },
            {
                envFilePath: "/tmp/artgod/runtime.env",
            },
        );

        assert.equal(config.chainId, 1);
        assert.equal(config.rpc.primaryUrl, "http://127.0.0.1:8545");
        assert.equal(
            config.tokens.wethAddress,
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        );
        assert.equal(config.bidding.enabled, true);
        if (!config.bidding.enabled) {
            throw new Error("Expected bidding to be enabled");
        }
        assert.equal(config.bidding.pollMs, 8 * 60 * 1000);
        assert.equal(config.bidding.jobsFile, "/tmp/artgod/jobs/bidding.json");
        assert.equal(config.bidding.wethAllowanceWei, 0n);
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
            config.bidding.criteriaRefreshTraitsByCollection.terraforms,
            ["Zone", "Biome", "Level"],
        );
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
                BIDDING_JOBS_FILE: "./jobs/bidding.json",
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

    it("parses explicit trait map overrides", () => {
        const config = loadTradingConfig(
            {
                ...requiredBaseEnv,
                BIDDING_ENABLED: "true",
                BIDDING_JOBS_FILE: "./jobs/bidding.json",
                OPENSEA_STREAM_SECRET_KEY: "stream-key",
                OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                BIDDING_WETH_ALLOWANCE_ETH: "2.5",
                BIDDING_TX_MIN_PRIORITY_FEE_GWEI: "0.25",
                BIDDING_TX_FEE_HISTORY_BLOCKS: "12",
                BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE: "80",
                BIDDING_TX_BASE_FEE_MULTIPLIER: "1.5",
                BIDDING_TX_MAX_FEE_GWEI: "120",
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
        assert.equal(config.bidding.wethAllowanceWei, parseEther("2.5"));
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
                        BIDDING_JOBS_FILE: "./jobs/bidding.json",
                        OPENSEA_STREAM_SECRET_KEY: "stream-key",
                        OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                        OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                        BIDDING_WETH_ALLOWANCE_ETH: "not-ether",
                    },
                    {
                        envFilePath: "/tmp/artgod/runtime.env",
                    },
                ),
            /Invalid BIDDING_WETH_ALLOWANCE_ETH/,
        );
    });

    it("rejects invalid transaction fee policy values", () => {
        assert.throws(
            () =>
                loadTradingConfig(
                    {
                        ...requiredBaseEnv,
                        BIDDING_ENABLED: "true",
                        BIDDING_JOBS_FILE: "./jobs/bidding.json",
                        OPENSEA_STREAM_SECRET_KEY: "stream-key",
                        OPENSEA_BIDDING_SECRET_KEY: "bidding-key",
                        OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                        BIDDING_TX_MIN_PRIORITY_FEE_GWEI: "0",
                    },
                    {
                        envFilePath: "/tmp/artgod/runtime.env",
                    },
                ),
            /Invalid BIDDING_TX_MIN_PRIORITY_FEE_GWEI/,
        );

        assert.throws(
            () =>
                loadTradingConfig(
                    {
                        ...requiredBaseEnv,
                        BIDDING_ENABLED: "true",
                        BIDDING_JOBS_FILE: "./jobs/bidding.json",
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
                        BIDDING_JOBS_FILE: "./jobs/bidding.json",
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
