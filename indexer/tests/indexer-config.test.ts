import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";

const REQUIRED_ENV = {
    ARTGOD_DB_PATH: "database/sqlite/test/db",
    RPC_URL: "http://127.0.0.1:8545",
    WETH_ADDRESS: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    SEAPORT_CONDUIT_CONTROLLER: "0x00000000f9490004c11cef243f5400493c00ad63",
};

describe("Indexer config", () => {
    it("normalizes canonical address config to lowercase", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            SEAPORT_CONDUIT_CONTROLLER:
                "0x00000000F9490004C11cef243F5400493C00AD63",
        });

        expect(config.tokens.wethAddress).toBe(
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        );
        expect(config.seaport.conduitController).toBe(
            "0x00000000f9490004c11cef243f5400493c00ad63",
        );
    });

    it("persists raw offchain observations by default", () => {
        const config = loadConfig(REQUIRED_ENV);

        expect(config.offchain.persistRawObservations).toBe(true);
    });

    it("allows disabling raw offchain observation persistence", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            OFFCHAIN_PERSIST_RAW_OBSERVATIONS: "false",
        });

        expect(config.offchain.persistRawObservations).toBe(false);
    });
});
