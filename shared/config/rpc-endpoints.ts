export type RpcEndpointConfig = {
    url: string;
    weight: number;
};

export type WeightedRpcEndpointTarget<T> = RpcEndpointConfig & {
    id?: string;
    value: T;
};

export type WeightedRpcEndpointSelection<T> = {
    id: string;
    url: string;
    configuredWeight: number;
    effectiveWeight: number;
    value: T;
};

type WeightedRpcEndpointState<T> = {
    id: string;
    url: string;
    configuredWeight: number;
    value: T;
    consecutiveFailures: number;
    currentWeight: number;
};

const RPC_ENDPOINT_PROTOCOLS = new Set(["http:", "https:"]);
const RPC_ENDPOINT_EXPLICIT_URL_SCHEME_PATTERN = /^https?:\/\//;
const MAX_FAILURE_PENALTY_EXPONENT = 8;
const MIN_EFFECTIVE_WEIGHT = 0.01;

export const DEFAULT_RPC_ENDPOINT_WEIGHT = 1;

// Parses the runtime RPC endpoint list from the structured env value.
export function parseRpcEndpointConfigList(
    value: string | undefined,
    key = "RPC_URL",
): RpcEndpointConfig[] {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) {
        throw new Error(`Missing ${key}`);
    }

    if (!trimmed.startsWith("[")) {
        throw new Error(`Invalid ${key}: endpoint list must be a JSON array`);
    }
    return parseJsonRpcEndpoints(trimmed, key);
}

// Serializes validated endpoints for Admin-managed settings and env rendering.
export function serializeRpcEndpointConfigList(
    endpoints: readonly RpcEndpointConfig[],
): string {
    return JSON.stringify(
        endpoints.map((endpoint, index) =>
            normalizeRpcEndpointConfig(endpoint, "RPC_URL", index),
        ),
    );
}

// Smooth weighted round-robin selector with failure-sensitive effective weights.
export class WeightedRpcEndpointSelector<T> {
    private readonly states: WeightedRpcEndpointState<T>[];

    constructor(targets: readonly WeightedRpcEndpointTarget<T>[]) {
        if (targets.length === 0) {
            throw new Error("At least one RPC endpoint is required");
        }
        this.states = targets.map((target, index) => {
            const normalized = normalizeRpcEndpointConfig(
                target,
                "RPC_URL",
                index,
            );
            return {
                id: target.id ?? `rpc-${index + 1}`,
                url: normalized.url,
                configuredWeight: normalized.weight,
                value: target.value,
                consecutiveFailures: 0,
                currentWeight: 0,
            };
        });
    }

    select(): WeightedRpcEndpointSelection<T> {
        let totalWeight = 0;
        let selected = this.states[0];

        for (const state of this.states) {
            const weight = this.effectiveWeight(state);
            state.currentWeight += weight;
            totalWeight += weight;
            if (state.currentWeight > selected.currentWeight) {
                selected = state;
            }
        }

        selected.currentWeight -= totalWeight;
        return this.toSelection(selected);
    }

    recordSuccess(id: string): void {
        const state = this.findState(id);
        if (!state) return;
        state.consecutiveFailures = Math.max(0, state.consecutiveFailures - 1);
    }

    recordFailure(id: string): void {
        const state = this.findState(id);
        if (!state) return;
        state.consecutiveFailures = Math.min(
            MAX_FAILURE_PENALTY_EXPONENT,
            state.consecutiveFailures + 1,
        );
    }

    snapshot(): WeightedRpcEndpointSelection<T>[] {
        return this.states.map((state) => this.toSelection(state));
    }

    private findState(id: string): WeightedRpcEndpointState<T> | undefined {
        return this.states.find((state) => state.id === id);
    }

    private toSelection(
        state: WeightedRpcEndpointState<T>,
    ): WeightedRpcEndpointSelection<T> {
        return {
            id: state.id,
            url: state.url,
            configuredWeight: state.configuredWeight,
            effectiveWeight: this.effectiveWeight(state),
            value: state.value,
        };
    }

    private effectiveWeight(state: WeightedRpcEndpointState<T>): number {
        const penalty = 2 ** state.consecutiveFailures;
        return Math.max(MIN_EFFECTIVE_WEIGHT, state.configuredWeight / penalty);
    }
}

function parseJsonRpcEndpoints(raw: string, key: string): RpcEndpointConfig[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Invalid ${key}: endpoint list must be valid JSON (${message})`,
        );
    }

    if (!Array.isArray(parsed)) {
        throw new Error(`Invalid ${key}: endpoint list must be a JSON array`);
    }
    const entries = parsed;
    if (entries.length === 0) {
        throw new Error(`Invalid ${key}: endpoint list cannot be empty`);
    }

    return entries.map((entry, index) =>
        parseJsonRpcEndpoint(entry, key, index),
    );
}

function parseJsonRpcEndpoint(
    entry: unknown,
    key: string,
    index: number,
): RpcEndpointConfig {
    if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        return normalizeRpcEndpointConfig(
            {
                url: String(record.url ?? ""),
                weight: parseEndpointWeight(record.weight, key, index),
            },
            key,
            index,
        );
    }
    throw new Error(`Invalid ${key}: endpoint ${index + 1} must be an object`);
}

function normalizeRpcEndpointConfig(
    endpoint: RpcEndpointConfig,
    key: string,
    index: number,
): RpcEndpointConfig {
    const url = endpoint.url.trim();
    if (url.length === 0) {
        throw new Error(`Invalid ${key}: endpoint ${index + 1} URL is empty`);
    }
    assertRpcHttpUrl(url, key, index);
    return {
        url,
        weight: parseEndpointWeight(endpoint.weight, key, index),
    };
}

function assertRpcHttpUrl(url: string, key: string, index: number): void {
    if (!RPC_ENDPOINT_EXPLICIT_URL_SCHEME_PATTERN.test(url)) {
        throw new Error(`Invalid ${key}: endpoint ${index + 1} URL is invalid`);
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid ${key}: endpoint ${index + 1} URL is invalid`);
    }
    if (
        !RPC_ENDPOINT_PROTOCOLS.has(parsed.protocol) ||
        parsed.hostname.trim().length === 0
    ) {
        throw new Error(
            `Invalid ${key}: endpoint ${index + 1} must use http or https`,
        );
    }
}

function parseEndpointWeight(
    value: unknown,
    key: string,
    index: number,
): number {
    const raw =
        value === undefined || value === ""
            ? DEFAULT_RPC_ENDPOINT_WEIGHT
            : value;
    const weight = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isInteger(weight) || weight <= 0) {
        throw new Error(
            `Invalid ${key}: endpoint ${index + 1} weight must be a positive integer`,
        );
    }
    return weight;
}
