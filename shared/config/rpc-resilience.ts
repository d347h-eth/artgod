import {
    getSettingDefault,
    getSettingDefaultNumber,
    SETTINGS_KEY,
    type SettingsDefaultKey,
} from "./generated-settings-defaults.js";
import {
    parseEnum,
    parseNumber,
    parsePositiveInteger,
    parsePositiveNumber,
} from "../utils/env.js";
import { RPC_RATE_LIMIT_MODE } from "../evm/rpc-resilience.js";
import type {
    RpcEndpointResilienceConfig,
    RpcRetryPolicy,
    RpcRateLimiterConfig,
} from "../evm/rpc-resilience.js";

// Env keys that define shared HTTP JSON-RPC retry and per-endpoint resilience policy.
export const RPC_RESILIENCE_ENV_KEY = {
    HttpRequestTimeoutMs: "RPC_HTTP_REQUEST_TIMEOUT_MS",
    HttpMaxResponseBodySizeBytes:
        SETTINGS_KEY.RPC_HTTP_MAX_RESPONSE_BODY_SIZE_BYTES,
    RetryMaxAttempts: "RPC_RETRY_MAX_ATTEMPTS",
    RetryBaseDelayMs: "RPC_RETRY_BASE_DELAY_MS",
    RetryMaxDelayMs: "RPC_RETRY_MAX_DELAY_MS",
    RateLimitRequestsPerSecond: "RPC_RATE_LIMIT_REQUESTS_PER_SECOND",
    RateLimitMode: "RPC_RATE_LIMIT_MODE",
    RateLimitBurst: "RPC_RATE_LIMIT_BURST",
    CircuitBreakerFailureThreshold: "RPC_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
    CircuitBreakerOpenMs: "RPC_CIRCUIT_BREAKER_OPEN_MS",
    CircuitBreakerHalfOpenMaxRequests:
        "RPC_CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS",
} as const satisfies Record<string, SettingsDefaultKey>;

/** Validate saved numeric values in every mode; only limited policies carry capacities. */
export function parseRpcRateLimiterConfig(
    env: Record<string, string | undefined>,
): RpcRateLimiterConfig {
    const mode = parseEnum(
        env[RPC_RESILIENCE_ENV_KEY.RateLimitMode],
        RPC_RESILIENCE_ENV_KEY.RateLimitMode,
        Object.values(RPC_RATE_LIMIT_MODE),
        getSettingDefault(RPC_RESILIENCE_ENV_KEY.RateLimitMode),
    );
    const requestsPerSecond = parsePositiveNumber(
        env[RPC_RESILIENCE_ENV_KEY.RateLimitRequestsPerSecond],
        RPC_RESILIENCE_ENV_KEY.RateLimitRequestsPerSecond,
        getSettingDefaultNumber(
            RPC_RESILIENCE_ENV_KEY.RateLimitRequestsPerSecond,
        ),
    );
    const burst = parsePositiveInteger(
        env[RPC_RESILIENCE_ENV_KEY.RateLimitBurst],
        RPC_RESILIENCE_ENV_KEY.RateLimitBurst,
        getSettingDefaultNumber(RPC_RESILIENCE_ENV_KEY.RateLimitBurst),
    );
    return mode === RPC_RATE_LIMIT_MODE.Unlimited
        ? { mode }
        : { mode, requestsPerSecond, burst };
}

// Parses the shared JSON-RPC retry policy from manifest-backed env values.
export function parseRpcRetryPolicy(
    env: Record<string, string | undefined>,
): RpcRetryPolicy {
    return {
        maxAttempts: parsePositiveInteger(
            env[RPC_RESILIENCE_ENV_KEY.RetryMaxAttempts],
            RPC_RESILIENCE_ENV_KEY.RetryMaxAttempts,
            getSettingDefaultNumber(RPC_RESILIENCE_ENV_KEY.RetryMaxAttempts),
        ),
        baseDelayMs: parseNumber(
            env[RPC_RESILIENCE_ENV_KEY.RetryBaseDelayMs],
            RPC_RESILIENCE_ENV_KEY.RetryBaseDelayMs,
            getSettingDefaultNumber(RPC_RESILIENCE_ENV_KEY.RetryBaseDelayMs),
        ),
        maxDelayMs: parseNumber(
            env[RPC_RESILIENCE_ENV_KEY.RetryMaxDelayMs],
            RPC_RESILIENCE_ENV_KEY.RetryMaxDelayMs,
            getSettingDefaultNumber(RPC_RESILIENCE_ENV_KEY.RetryMaxDelayMs),
        ),
    };
}

// Parses the shared per-endpoint JSON-RPC resilience policy from env values.
export function parseRpcEndpointResilienceConfig(
    env: Record<string, string | undefined>,
): RpcEndpointResilienceConfig {
    return {
        requestTimeoutMs: parseRpcHttpRequestTimeoutMs(env),
        maxResponseBodySizeBytes: parsePositiveInteger(
            env[RPC_RESILIENCE_ENV_KEY.HttpMaxResponseBodySizeBytes],
            RPC_RESILIENCE_ENV_KEY.HttpMaxResponseBodySizeBytes,
            getSettingDefaultNumber(
                RPC_RESILIENCE_ENV_KEY.HttpMaxResponseBodySizeBytes,
            ),
        ),
        rateLimiter: parseRpcRateLimiterConfig(env),
        circuitBreaker: {
            failureThreshold: parsePositiveInteger(
                env[RPC_RESILIENCE_ENV_KEY.CircuitBreakerFailureThreshold],
                RPC_RESILIENCE_ENV_KEY.CircuitBreakerFailureThreshold,
                getSettingDefaultNumber(
                    RPC_RESILIENCE_ENV_KEY.CircuitBreakerFailureThreshold,
                ),
            ),
            openMs: parsePositiveInteger(
                env[RPC_RESILIENCE_ENV_KEY.CircuitBreakerOpenMs],
                RPC_RESILIENCE_ENV_KEY.CircuitBreakerOpenMs,
                getSettingDefaultNumber(
                    RPC_RESILIENCE_ENV_KEY.CircuitBreakerOpenMs,
                ),
            ),
            halfOpenMaxRequests: parsePositiveInteger(
                env[RPC_RESILIENCE_ENV_KEY.CircuitBreakerHalfOpenMaxRequests],
                RPC_RESILIENCE_ENV_KEY.CircuitBreakerHalfOpenMaxRequests,
                getSettingDefaultNumber(
                    RPC_RESILIENCE_ENV_KEY.CircuitBreakerHalfOpenMaxRequests,
                ),
            ),
        },
    };
}

// Parses the per-attempt timeout for HTTP JSON-RPC request attempts.
export function parseRpcHttpRequestTimeoutMs(
    env: Record<string, string | undefined>,
): number {
    return parsePositiveInteger(
        env[RPC_RESILIENCE_ENV_KEY.HttpRequestTimeoutMs],
        RPC_RESILIENCE_ENV_KEY.HttpRequestTimeoutMs,
        getSettingDefaultNumber(RPC_RESILIENCE_ENV_KEY.HttpRequestTimeoutMs),
    );
}

// Returns manifest defaults for adapters constructed outside runtime config.
export function getDefaultRpcRetryPolicy(): RpcRetryPolicy {
    return parseRpcRetryPolicy({});
}

// Returns manifest resilience defaults for adapters constructed outside runtime config.
export function getDefaultRpcEndpointResilienceConfig(): RpcEndpointResilienceConfig {
    return parseRpcEndpointResilienceConfig({});
}
