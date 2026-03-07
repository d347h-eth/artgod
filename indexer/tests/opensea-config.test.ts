import { describe, expect, it } from "vitest";
import { loadOpenSeaConfig } from "../src/config/opensea.js";

describe("OpenSea config", () => {
    it("loads without fixture env vars", () => {
        const config = loadOpenSeaConfig({
            ARTGOD_DB_PATH: "database/sqlite/test/db",
            OPENSEA_API_KEY: "test-opensea-api-key",
        });

        expect(config.opensea.apiKey).toBe("test-opensea-api-key");
        expect(config.opensea.snapshotPageSize).toBe(100);
        expect("streamMode" in config.opensea).toBe(false);
    });
});
