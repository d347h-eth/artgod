import { describe, expect, it } from "vitest";
import { getSettingDefaultNumber } from "./generated-settings-defaults.js";
import {
    parseRpcEndpointResilienceConfig,
    RPC_RESILIENCE_ENV_KEY,
} from "./rpc-resilience.js";

const limitKey = RPC_RESILIENCE_ENV_KEY.HttpMaxResponseBodySizeBytes;

describe("HTTP RPC response-size configuration", () => {
    it.each([undefined, "", " "])(
        "uses the manifest limit when the override is %s",
        (value) => {
            expect(
                parseRpcEndpointResilienceConfig({ [limitKey]: value })
                    .maxResponseBodySizeBytes,
            ).toBe(getSettingDefaultNumber(limitKey));
        },
    );

    it.each([1, 524_288, 20_971_520, Number.MAX_SAFE_INTEGER])(
        "accepts a positive byte limit of %i",
        (limit) => {
            expect(
                parseRpcEndpointResilienceConfig({ [limitKey]: String(limit) })
                    .maxResponseBodySizeBytes,
            ).toBe(limit);
        },
    );

    it.each([
        "0",
        "-1",
        "1.5",
        "false",
        "NaN",
        "Infinity",
        "9007199254740992",
        "9007199254740993",
        "1e7",
        "0x100000",
        "01",
        "+1",
    ])("rejects an invalid byte limit of %s", (value) => {
        expect(() =>
            parseRpcEndpointResilienceConfig({ [limitKey]: value }),
        ).toThrow(`Invalid ${limitKey}`);
    });
});
