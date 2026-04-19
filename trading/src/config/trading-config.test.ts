import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
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

    it("rejects duplicated OpenSea lane keys when bidding is enabled", () => {
        assert.throws(
            () =>
                loadTradingConfig(
                    {
                        ...requiredBaseEnv,
                        BIDDING_ENABLED: "true",
                        BIDDING_JOBS_FILE: "./jobs/bidding.json",
                        OPENSEA_STREAM_SECRET_KEY: "shared-key",
                        OPENSEA_BIDDING_SECRET_KEY: "shared-key",
                        OPENSEA_SNAPSHOT_SECRET_KEY: "snapshot-key",
                    },
                    {
                        envFilePath: "/tmp/artgod/runtime.env",
                    },
                ),
            /must stay split by lane/,
        );
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
    });
});
