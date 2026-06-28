import { describe, expect, it } from "vitest";
import { getSettingDefaultNumber } from "./generated-settings-defaults.js";
import {
    getDefaultOpenSeaHttpConfig,
    OPENSEA_HTTP_ENV_KEY,
    parseOpenSeaHttpConfig,
} from "./opensea-http.js";

describe("parseOpenSeaHttpConfig", () => {
    it("uses manifest defaults", () => {
        expect(getDefaultOpenSeaHttpConfig()).toEqual({
            retryPolicy: {
                maxAttempts: getSettingDefaultNumber(
                    OPENSEA_HTTP_ENV_KEY.RetryMaxAttempts,
                ),
                baseDelayMs: getSettingDefaultNumber(
                    OPENSEA_HTTP_ENV_KEY.RetryBaseDelayMs,
                ),
                maxDelayMs: getSettingDefaultNumber(
                    OPENSEA_HTTP_ENV_KEY.RetryMaxDelayMs,
                ),
                jitterRatio: getSettingDefaultNumber(
                    OPENSEA_HTTP_ENV_KEY.RetryJitterRatio,
                ),
            },
            rateLimiter: {
                getMax: getSettingDefaultNumber(
                    OPENSEA_HTTP_ENV_KEY.RateLimitGetMax,
                ),
                getRefillPerSecond: getSettingDefaultNumber(
                    OPENSEA_HTTP_ENV_KEY.RateLimitGetRefillPerSecond,
                ),
                postMax: getSettingDefaultNumber(
                    OPENSEA_HTTP_ENV_KEY.RateLimitPostMax,
                ),
                postRefillPerSecond: getSettingDefaultNumber(
                    OPENSEA_HTTP_ENV_KEY.RateLimitPostRefillPerSecond,
                ),
            },
        });
    });

    it("parses overrides", () => {
        expect(
            parseOpenSeaHttpConfig({
                [OPENSEA_HTTP_ENV_KEY.RetryMaxAttempts]: "4",
                [OPENSEA_HTTP_ENV_KEY.RetryBaseDelayMs]: "250",
                [OPENSEA_HTTP_ENV_KEY.RetryMaxDelayMs]: "1500",
                [OPENSEA_HTTP_ENV_KEY.RetryJitterRatio]: "0.15",
                [OPENSEA_HTTP_ENV_KEY.RateLimitGetMax]: "6",
                [OPENSEA_HTTP_ENV_KEY.RateLimitGetRefillPerSecond]: "1.5",
                [OPENSEA_HTTP_ENV_KEY.RateLimitPostMax]: "3",
                [OPENSEA_HTTP_ENV_KEY.RateLimitPostRefillPerSecond]: "0.75",
            }),
        ).toEqual({
            retryPolicy: {
                maxAttempts: 4,
                baseDelayMs: 250,
                maxDelayMs: 1500,
                jitterRatio: 0.15,
            },
            rateLimiter: {
                getMax: 6,
                getRefillPerSecond: 1.5,
                postMax: 3,
                postRefillPerSecond: 0.75,
            },
        });
    });
});
