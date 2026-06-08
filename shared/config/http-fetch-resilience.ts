import {
    getSettingDefaultNumber,
    type SettingsDefaultKey,
} from "./generated-settings-defaults.js";
import { parseNumber, parsePositiveInteger } from "../utils/env.js";
import type {
    HttpFetchResilienceConfig,
    HttpFetchRetryPolicy,
} from "../network/http-fetch-resilience.js";

// Env keys that define ordinary HTTP fetch timeout and retry policy.
export const HTTP_FETCH_RESILIENCE_ENV_KEY = {
    RequestTimeoutMs: "COMMON_HTTP_FETCH_TIMEOUT_MS",
    RetryMaxAttempts: "COMMON_HTTP_FETCH_RETRY_MAX_ATTEMPTS",
    RetryBaseDelayMs: "COMMON_HTTP_FETCH_RETRY_BASE_DELAY_MS",
    RetryMaxDelayMs: "COMMON_HTTP_FETCH_RETRY_MAX_DELAY_MS",
} as const satisfies Record<string, SettingsDefaultKey>;

// Parses the shared normal HTTP retry policy from manifest-backed env values.
export function parseHttpFetchRetryPolicy(
    env: Record<string, string | undefined>,
): HttpFetchRetryPolicy {
    return {
        maxAttempts: parsePositiveInteger(
            env[HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxAttempts],
            HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxAttempts,
            getSettingDefaultNumber(
                HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxAttempts,
            ),
        ),
        baseDelayMs: parseNumber(
            env[HTTP_FETCH_RESILIENCE_ENV_KEY.RetryBaseDelayMs],
            HTTP_FETCH_RESILIENCE_ENV_KEY.RetryBaseDelayMs,
            getSettingDefaultNumber(
                HTTP_FETCH_RESILIENCE_ENV_KEY.RetryBaseDelayMs,
            ),
        ),
        maxDelayMs: parseNumber(
            env[HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxDelayMs],
            HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxDelayMs,
            getSettingDefaultNumber(
                HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxDelayMs,
            ),
        ),
    };
}

// Parses shared normal HTTP timeout and retry policy from env values.
export function parseHttpFetchResilienceConfig(
    env: Record<string, string | undefined>,
): HttpFetchResilienceConfig {
    return {
        requestTimeoutMs: parsePositiveInteger(
            env[HTTP_FETCH_RESILIENCE_ENV_KEY.RequestTimeoutMs],
            HTTP_FETCH_RESILIENCE_ENV_KEY.RequestTimeoutMs,
            getSettingDefaultNumber(
                HTTP_FETCH_RESILIENCE_ENV_KEY.RequestTimeoutMs,
            ),
        ),
        retryPolicy: parseHttpFetchRetryPolicy(env),
    };
}

// Returns manifest defaults for fetchers constructed outside runtime config.
export function getDefaultHttpFetchResilienceConfig(): HttpFetchResilienceConfig {
    return parseHttpFetchResilienceConfig({});
}
