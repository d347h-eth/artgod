import {
    WeightedEndpointSelector,
    type WeightedEndpointSelection,
} from "../config/weighted-endpoints.js";
import type {
    RpcObservability,
    RpcCallContext,
    RpcEndpointAttemptContext,
} from "../observability/rpc.js";
import {
    CircuitBreaker,
    CircuitOpenError,
    executeWithRpcRetry,
    TokenBucketRateLimiter,
    type RpcRetryPolicy,
} from "./rpc-resilience.js";

// Result returned after one observed endpoint execution attempt.
export type ObservedRpcEndpointExecution<TEndpoint, TValue> = {
    value: TValue;
    endpoint: WeightedEndpointSelection<TEndpoint>;
};

// Hook that lets adapters wrap a single endpoint attempt with local concerns such as APM spans.
export type RpcEndpointAttemptWrapper<TEndpoint> = <TValue>(
    endpoint: WeightedEndpointSelection<TEndpoint>,
    run: () => Promise<TValue>,
) => Promise<TValue>;

// Options for running one RPC call through weighted endpoint selection and shared observability.
export type ObservedRpcEndpointCallOptions<TEndpoint, TValue> = {
    selector: WeightedEndpointSelector<TEndpoint>;
    method: string;
    execute: (
        endpoint: WeightedEndpointSelection<TEndpoint>,
    ) => Promise<TValue>;
    rpcObservability?: RpcObservability;
    retryPolicy?: RpcRetryPolicy;
    sleep?: (ms: number) => Promise<void>;
    circuitBreaker?: (
        endpoint: WeightedEndpointSelection<TEndpoint>,
    ) => CircuitBreaker | undefined;
    rateLimiter?: (
        endpoint: WeightedEndpointSelection<TEndpoint>,
    ) => TokenBucketRateLimiter | undefined;
    wrapAttempt?: RpcEndpointAttemptWrapper<TEndpoint>;
    onEndpointFailure?: (
        endpoint: WeightedEndpointSelection<TEndpoint>,
        error: unknown,
    ) => void;
};

// Deferred recorder for adapters that cannot classify success until after response parsing.
export type ObservedRpcEndpointAttempt<TEndpoint> = {
    endpoint: WeightedEndpointSelection<TEndpoint>;
    recordSuccess(): WeightedEndpointSelection<TEndpoint>;
    recordFailure(error: unknown): WeightedEndpointSelection<TEndpoint>;
};

type RpcEndpointAttemptInput<TEndpoint, TValue> = {
    options: ObservedRpcEndpointCallOptions<TEndpoint, TValue>;
    call?: RpcCallContext;
    attempt: number;
    onEndpointObserved: (
        endpoint: WeightedEndpointSelection<TEndpoint>,
    ) => void;
};

// Executes an RPC call with shared endpoint selection, retry, circuit, rate-limit, logs, and metrics.
export async function executeObservedRpcEndpointCall<TEndpoint, TValue>(
    options: ObservedRpcEndpointCallOptions<TEndpoint, TValue>,
): Promise<TValue> {
    const call = options.rpcObservability?.startCall(options.method);
    let lastEndpoint: WeightedEndpointSelection<TEndpoint> | null = null;
    const executeAttempt = (attempt: number) =>
        executeObservedRpcEndpointAttempt({
            options,
            call,
            attempt,
            onEndpointObserved: (endpoint) => {
                lastEndpoint = endpoint;
            },
        });

    try {
        const result = options.retryPolicy
            ? await executeWithRpcRetry({
                  policy: options.retryPolicy,
                  sleep: options.sleep,
                  executeAttempt,
                  onRetryScheduled: ({ attempt, nextAttempt, delayMs }) => {
                      if (!lastEndpoint) return;
                      options.rpcObservability?.recordRetryScheduled({
                          method: options.method,
                          endpoint: lastEndpoint,
                          attempt,
                          nextAttempt,
                          delayMs,
                      });
                  },
              })
            : await executeAttempt(1);

        if (call) {
            options.rpcObservability?.recordCallSuccess(call, result.endpoint);
        }
        return result.value;
    } catch (error) {
        if (call) {
            options.rpcObservability?.recordCallFailure(
                call,
                lastEndpoint,
                error,
            );
        }
        throw error;
    }
}

// Starts one observed endpoint attempt for adapters with deferred response validation.
export function startObservedRpcEndpointAttempt<TEndpoint>(input: {
    selector: WeightedEndpointSelector<TEndpoint>;
    method: string;
    rpcObservability: RpcObservability;
    attempt?: number;
}): ObservedRpcEndpointAttempt<TEndpoint> {
    const call = input.rpcObservability.startCall(input.method);
    const endpoint = input.selector.select();
    const attempt = input.rpcObservability.startEndpointAttempt(
        call,
        endpoint,
        input.attempt ?? 1,
    );

    return {
        endpoint,
        recordSuccess: () =>
            recordObservedRpcEndpointAttemptSuccess({
                selector: input.selector,
                rpcObservability: input.rpcObservability,
                call,
                attempt,
                endpoint,
            }),
        recordFailure: (error) =>
            recordObservedRpcEndpointAttemptFailure({
                selector: input.selector,
                rpcObservability: input.rpcObservability,
                call,
                attempt,
                endpoint,
                error,
            }),
    };
}

async function executeObservedRpcEndpointAttempt<TEndpoint, TValue>(
    input: RpcEndpointAttemptInput<TEndpoint, TValue>,
): Promise<ObservedRpcEndpointExecution<TEndpoint, TValue>> {
    const endpoint = input.options.selector.select();
    input.onEndpointObserved(endpoint);
    const attemptContext =
        input.call &&
        input.options.rpcObservability?.startEndpointAttempt(
            input.call,
            endpoint,
            input.attempt,
        );

    try {
        const value = await runObservedRpcEndpointAttempt(
            input.options,
            endpoint,
        );
        const updatedEndpoint =
            input.options.selector.recordSuccess(endpoint.id) ?? endpoint;
        input.onEndpointObserved(updatedEndpoint);
        if (attemptContext) {
            input.options.rpcObservability?.recordEndpointAttemptSuccess(
                attemptContext,
                updatedEndpoint,
            );
        }
        return {
            value,
            endpoint: updatedEndpoint,
        };
    } catch (error) {
        const updatedEndpoint =
            input.options.selector.recordFailure(endpoint.id) ?? endpoint;
        input.onEndpointObserved(updatedEndpoint);
        if (error instanceof CircuitOpenError) {
            input.options.rpcObservability?.recordCircuitOpen(
                input.options.method,
                updatedEndpoint,
                error,
            );
        }
        if (attemptContext) {
            input.options.rpcObservability?.recordEndpointAttemptFailure(
                attemptContext,
                updatedEndpoint,
                error,
            );
        }
        input.options.onEndpointFailure?.(updatedEndpoint, error);
        throw error;
    }
}

async function runObservedRpcEndpointAttempt<TEndpoint, TValue>(
    options: ObservedRpcEndpointCallOptions<TEndpoint, TValue>,
    endpoint: WeightedEndpointSelection<TEndpoint>,
): Promise<TValue> {
    const run = () =>
        runWithOptionalCircuit(options, endpoint, () =>
            runWithOptionalRateLimit(options, endpoint, () =>
                options.execute(endpoint),
            ),
        );
    return options.wrapAttempt ? options.wrapAttempt(endpoint, run) : run();
}

async function runWithOptionalCircuit<TEndpoint, TValue>(
    options: ObservedRpcEndpointCallOptions<TEndpoint, TValue>,
    endpoint: WeightedEndpointSelection<TEndpoint>,
    run: () => Promise<TValue>,
): Promise<TValue> {
    const circuitBreaker = options.circuitBreaker?.(endpoint);
    return circuitBreaker ? circuitBreaker.execute(run) : run();
}

async function runWithOptionalRateLimit<TEndpoint, TValue>(
    options: ObservedRpcEndpointCallOptions<TEndpoint, TValue>,
    endpoint: WeightedEndpointSelection<TEndpoint>,
    run: () => Promise<TValue>,
): Promise<TValue> {
    const rateLimiter = options.rateLimiter?.(endpoint);
    if (!rateLimiter) return run();

    const waitedMs = await rateLimiter.acquire();
    if (waitedMs > 0) {
        options.rpcObservability?.recordRateLimitWait({
            method: options.method,
            endpoint,
            waitedMs,
        });
    }
    return run();
}

function recordObservedRpcEndpointAttemptSuccess<TEndpoint>(input: {
    selector: WeightedEndpointSelector<TEndpoint>;
    rpcObservability: RpcObservability;
    call: RpcCallContext;
    attempt: RpcEndpointAttemptContext;
    endpoint: WeightedEndpointSelection<TEndpoint>;
}): WeightedEndpointSelection<TEndpoint> {
    const endpoint =
        input.selector.recordSuccess(input.endpoint.id) ?? input.endpoint;
    input.rpcObservability.recordEndpointAttemptSuccess(
        input.attempt,
        endpoint,
    );
    input.rpcObservability.recordCallSuccess(input.call, endpoint);
    return endpoint;
}

function recordObservedRpcEndpointAttemptFailure<TEndpoint>(input: {
    selector: WeightedEndpointSelector<TEndpoint>;
    rpcObservability: RpcObservability;
    call: RpcCallContext;
    attempt: RpcEndpointAttemptContext;
    endpoint: WeightedEndpointSelection<TEndpoint>;
    error: unknown;
}): WeightedEndpointSelection<TEndpoint> {
    const endpoint =
        input.selector.recordFailure(input.endpoint.id) ?? input.endpoint;
    input.rpcObservability.recordEndpointAttemptFailure(
        input.attempt,
        endpoint,
        input.error,
    );
    input.rpcObservability.recordCallFailure(input.call, endpoint, input.error);
    return endpoint;
}
