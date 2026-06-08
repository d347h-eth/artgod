import { describe, expect, it } from "vitest";
import {
    getDefaultHttpFetchResilienceConfig,
    HTTP_FETCH_RESILIENCE_ENV_KEY,
    parseHttpFetchResilienceConfig,
} from "./http-fetch-resilience.js";
import { getSettingDefaultNumber } from "./generated-settings-defaults.js";

describe("parseHttpFetchResilienceConfig", () => {
    it("uses manifest defaults", () => {
        expect(getDefaultHttpFetchResilienceConfig()).toEqual({
            requestTimeoutMs: getSettingDefaultNumber(
                HTTP_FETCH_RESILIENCE_ENV_KEY.RequestTimeoutMs,
            ),
            retryPolicy: {
                maxAttempts: getSettingDefaultNumber(
                    HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxAttempts,
                ),
                baseDelayMs: getSettingDefaultNumber(
                    HTTP_FETCH_RESILIENCE_ENV_KEY.RetryBaseDelayMs,
                ),
                maxDelayMs: getSettingDefaultNumber(
                    HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxDelayMs,
                ),
            },
        });
    });

    it("parses overrides", () => {
        expect(
            parseHttpFetchResilienceConfig({
                [HTTP_FETCH_RESILIENCE_ENV_KEY.RequestTimeoutMs]: "1500",
                [HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxAttempts]: "4",
                [HTTP_FETCH_RESILIENCE_ENV_KEY.RetryBaseDelayMs]: "125",
                [HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxDelayMs]: "900",
            }),
        ).toEqual({
            requestTimeoutMs: 1500,
            retryPolicy: {
                maxAttempts: 4,
                baseDelayMs: 125,
                maxDelayMs: 900,
            },
        });
    });
});
