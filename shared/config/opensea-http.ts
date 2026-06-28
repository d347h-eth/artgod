import {
    getSettingDefaultNumber,
    type SettingsDefaultKey,
} from "./generated-settings-defaults.js";
import { parseNumber, parsePositiveInteger } from "../utils/env.js";

// Env keys that define OpenSea HTTP retry and rate-limit behavior.
export const OPENSEA_HTTP_ENV_KEY = {
    RetryMaxAttempts: "OPENSEA_HTTP_RETRY_MAX_ATTEMPTS",
    RetryBaseDelayMs: "OPENSEA_HTTP_RETRY_BASE_DELAY_MS",
    RetryMaxDelayMs: "OPENSEA_HTTP_RETRY_MAX_DELAY_MS",
    RetryJitterRatio: "OPENSEA_HTTP_RETRY_JITTER_RATIO",
    RateLimitGetMax: "OPENSEA_RATE_LIMIT_GET_MAX",
    RateLimitGetRefillPerSecond: "OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND",
    RateLimitPostMax: "OPENSEA_RATE_LIMIT_POST_MAX",
    RateLimitPostRefillPerSecond: "OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND",
} as const satisfies Record<string, SettingsDefaultKey>;

// Retry policy used by OpenSea HTTP adapters.
export type OpenSeaHttpRetryPolicy = {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio: number;
};

// Token-bucket limits used by OpenSea HTTP adapters.
export type OpenSeaHttpRateLimiterConfig = {
    getMax: number;
    getRefillPerSecond: number;
    postMax: number;
    postRefillPerSecond: number;
};

// Combined OpenSea HTTP resilience contract for runtime composition.
export type OpenSeaHttpConfig = {
    retryPolicy: OpenSeaHttpRetryPolicy;
    rateLimiter: OpenSeaHttpRateLimiterConfig;
};

// Parses the OpenSea HTTP retry policy from manifest-backed env values.
export function parseOpenSeaHttpRetryPolicy(
    env: Record<string, string | undefined>,
): OpenSeaHttpRetryPolicy {
    return {
        maxAttempts: parsePositiveInteger(
            env[OPENSEA_HTTP_ENV_KEY.RetryMaxAttempts],
            OPENSEA_HTTP_ENV_KEY.RetryMaxAttempts,
            getSettingDefaultNumber(OPENSEA_HTTP_ENV_KEY.RetryMaxAttempts),
        ),
        baseDelayMs: parseNumber(
            env[OPENSEA_HTTP_ENV_KEY.RetryBaseDelayMs],
            OPENSEA_HTTP_ENV_KEY.RetryBaseDelayMs,
            getSettingDefaultNumber(OPENSEA_HTTP_ENV_KEY.RetryBaseDelayMs),
        ),
        maxDelayMs: parseNumber(
            env[OPENSEA_HTTP_ENV_KEY.RetryMaxDelayMs],
            OPENSEA_HTTP_ENV_KEY.RetryMaxDelayMs,
            getSettingDefaultNumber(OPENSEA_HTTP_ENV_KEY.RetryMaxDelayMs),
        ),
        jitterRatio: parseNumber(
            env[OPENSEA_HTTP_ENV_KEY.RetryJitterRatio],
            OPENSEA_HTTP_ENV_KEY.RetryJitterRatio,
            getSettingDefaultNumber(OPENSEA_HTTP_ENV_KEY.RetryJitterRatio),
        ),
    };
}

// Parses OpenSea HTTP token-bucket limits from manifest-backed env values.
export function parseOpenSeaHttpRateLimiterConfig(
    env: Record<string, string | undefined>,
): OpenSeaHttpRateLimiterConfig {
    return {
        getMax: parseNumber(
            env[OPENSEA_HTTP_ENV_KEY.RateLimitGetMax],
            OPENSEA_HTTP_ENV_KEY.RateLimitGetMax,
            getSettingDefaultNumber(OPENSEA_HTTP_ENV_KEY.RateLimitGetMax),
        ),
        getRefillPerSecond: parseNumber(
            env[OPENSEA_HTTP_ENV_KEY.RateLimitGetRefillPerSecond],
            OPENSEA_HTTP_ENV_KEY.RateLimitGetRefillPerSecond,
            getSettingDefaultNumber(
                OPENSEA_HTTP_ENV_KEY.RateLimitGetRefillPerSecond,
            ),
        ),
        postMax: parseNumber(
            env[OPENSEA_HTTP_ENV_KEY.RateLimitPostMax],
            OPENSEA_HTTP_ENV_KEY.RateLimitPostMax,
            getSettingDefaultNumber(OPENSEA_HTTP_ENV_KEY.RateLimitPostMax),
        ),
        postRefillPerSecond: parseNumber(
            env[OPENSEA_HTTP_ENV_KEY.RateLimitPostRefillPerSecond],
            OPENSEA_HTTP_ENV_KEY.RateLimitPostRefillPerSecond,
            getSettingDefaultNumber(
                OPENSEA_HTTP_ENV_KEY.RateLimitPostRefillPerSecond,
            ),
        ),
    };
}

// Parses OpenSea HTTP retry and rate-limit settings together.
export function parseOpenSeaHttpConfig(
    env: Record<string, string | undefined>,
): OpenSeaHttpConfig {
    return {
        retryPolicy: parseOpenSeaHttpRetryPolicy(env),
        rateLimiter: parseOpenSeaHttpRateLimiterConfig(env),
    };
}

// Returns manifest defaults for OpenSea HTTP adapters constructed outside runtime config.
export function getDefaultOpenSeaHttpConfig(): OpenSeaHttpConfig {
    return parseOpenSeaHttpConfig({});
}
