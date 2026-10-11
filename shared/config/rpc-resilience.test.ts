import { describe, expect, it } from "vitest";
import { getSettingDefaultNumber } from "./generated-settings-defaults.js";
import {
    parseRpcEndpointResilienceConfig,
    RPC_RESILIENCE_ENV_KEY,
    parseRpcRateLimiterConfig,
} from "./rpc-resilience.js";
import { RPC_RATE_LIMIT_MODE } from "../evm/rpc-resilience.js";

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

describe("explicit RPC rate policies", () => {
    it("defaults to finite manifest capacities", () => {
        expect(parseRpcRateLimiterConfig({})).toEqual({
            mode: RPC_RATE_LIMIT_MODE.Limited,
            requestsPerSecond: getSettingDefaultNumber(
                RPC_RESILIENCE_ENV_KEY.RateLimitRequestsPerSecond,
            ),
            burst: getSettingDefaultNumber(
                RPC_RESILIENCE_ENV_KEY.RateLimitBurst,
            ),
        });
    });
    it("represents unlimited explicitly and omits inactive capacities", () => {
        expect(
            parseRpcRateLimiterConfig({
                [RPC_RESILIENCE_ENV_KEY.RateLimitMode]:
                    RPC_RATE_LIMIT_MODE.Unlimited,
                [RPC_RESILIENCE_ENV_KEY.RateLimitRequestsPerSecond]: "1.5",
                [RPC_RESILIENCE_ENV_KEY.RateLimitBurst]: "3",
            }),
        ).toEqual({ mode: RPC_RATE_LIMIT_MODE.Unlimited });
    });
    it.each(["disabled", "0", "-1", "automatic"])(
        "rejects unknown RPC mode %s",
        (value) => {
            expect(() =>
                parseRpcRateLimiterConfig({
                    [RPC_RESILIENCE_ENV_KEY.RateLimitMode]: value,
                }),
            ).toThrow(RPC_RESILIENCE_ENV_KEY.RateLimitMode);
        },
    );
    it.each(Object.values(RPC_RATE_LIMIT_MODE))(
        "requires positive saved numeric capacities in %s mode",
        (mode) => {
            for (const value of ["0", "-1", "Infinity", "NaN"]) {
                expect(() =>
                    parseRpcRateLimiterConfig({
                        [RPC_RESILIENCE_ENV_KEY.RateLimitMode]: mode,
                        [RPC_RESILIENCE_ENV_KEY.RateLimitRequestsPerSecond]:
                            value,
                    }),
                ).toThrow(RPC_RESILIENCE_ENV_KEY.RateLimitRequestsPerSecond);
            }
            expect(() =>
                parseRpcRateLimiterConfig({
                    [RPC_RESILIENCE_ENV_KEY.RateLimitMode]: mode,
                    [RPC_RESILIENCE_ENV_KEY.RateLimitBurst]: "0",
                }),
            ).toThrow(RPC_RESILIENCE_ENV_KEY.RateLimitBurst);
        },
    );
});
