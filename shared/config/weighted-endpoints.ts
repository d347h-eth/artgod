export type WeightedEndpointConfig = {
    url: string;
    weight: number;
};

export type WeightedEndpointTarget<T> = WeightedEndpointConfig & {
    id?: string;
    value: T;
};

export type WeightedEndpointSelection<T> = {
    id: string;
    url: string;
    configuredWeight: number;
    effectiveWeight: number;
    value: T;
};

export type WeightedEndpointListValidation = {
    key: string;
    allowedProtocols: readonly string[];
    explicitSchemePattern: RegExp;
    protocolLabel: string;
};

type WeightedEndpointState<T> = {
    id: string;
    url: string;
    configuredWeight: number;
    value: T;
    consecutiveFailures: number;
    currentWeight: number;
};

const MAX_FAILURE_PENALTY_EXPONENT = 8;
const MIN_EFFECTIVE_WEIGHT = 0.01;

export const DEFAULT_ENDPOINT_WEIGHT = 1;

// Parses a structured weighted endpoint list while leaving protocol rules to the caller.
export function parseWeightedEndpointConfigList(
    value: string | undefined,
    validation: WeightedEndpointListValidation,
): WeightedEndpointConfig[] {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) {
        throw new Error(`Missing ${validation.key}`);
    }

    if (!trimmed.startsWith("[")) {
        throw new Error(
            `Invalid ${validation.key}: endpoint list must be a JSON array`,
        );
    }
    return parseJsonWeightedEndpoints(trimmed, validation);
}

// Serializes endpoint lists after applying the same normalization used at runtime.
export function serializeWeightedEndpointConfigList(
    endpoints: readonly WeightedEndpointConfig[],
    validation: WeightedEndpointListValidation,
): string {
    return JSON.stringify(
        endpoints.map((endpoint, index) =>
            normalizeWeightedEndpointConfig(endpoint, validation, index),
        ),
    );
}

// Smooth weighted round-robin selector with failure-sensitive effective weights.
export class WeightedEndpointSelector<T> {
    private readonly states: WeightedEndpointState<T>[];

    constructor(targets: readonly WeightedEndpointTarget<T>[]) {
        if (targets.length === 0) {
            throw new Error("At least one endpoint is required");
        }
        this.states = targets.map((target, index) => {
            const normalized = normalizeWeightedEndpointConfig(
                target,
                {
                    key: "endpoint",
                    allowedProtocols: [],
                    explicitSchemePattern: /^.+$/,
                    protocolLabel: "configured protocol",
                },
                index,
            );
            return {
                id: target.id ?? `endpoint-${index + 1}`,
                url: normalized.url,
                configuredWeight: normalized.weight,
                value: target.value,
                consecutiveFailures: 0,
                currentWeight: 0,
            };
        });
    }

    select(): WeightedEndpointSelection<T> {
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

    selectHighestEffectiveWeight(): WeightedEndpointSelection<T> {
        let selected = this.states[0];
        let selectedWeight = this.effectiveWeight(selected);

        for (const state of this.states.slice(1)) {
            const weight = this.effectiveWeight(state);
            if (weight > selectedWeight) {
                selected = state;
                selectedWeight = weight;
            }
        }

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

    snapshot(): WeightedEndpointSelection<T>[] {
        return this.states.map((state) => this.toSelection(state));
    }

    private findState(id: string): WeightedEndpointState<T> | undefined {
        return this.states.find((state) => state.id === id);
    }

    private toSelection(
        state: WeightedEndpointState<T>,
    ): WeightedEndpointSelection<T> {
        return {
            id: state.id,
            url: state.url,
            configuredWeight: state.configuredWeight,
            effectiveWeight: this.effectiveWeight(state),
            value: state.value,
        };
    }

    private effectiveWeight(state: WeightedEndpointState<T>): number {
        const penalty = 2 ** state.consecutiveFailures;
        return Math.max(MIN_EFFECTIVE_WEIGHT, state.configuredWeight / penalty);
    }
}

function parseJsonWeightedEndpoints(
    raw: string,
    validation: WeightedEndpointListValidation,
): WeightedEndpointConfig[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Invalid ${validation.key}: endpoint list must be valid JSON (${message})`,
        );
    }

    if (!Array.isArray(parsed)) {
        throw new Error(
            `Invalid ${validation.key}: endpoint list must be a JSON array`,
        );
    }
    const entries = parsed;
    if (entries.length === 0) {
        throw new Error(
            `Invalid ${validation.key}: endpoint list cannot be empty`,
        );
    }

    return entries.map((entry, index) =>
        parseJsonWeightedEndpoint(entry, validation, index),
    );
}

function parseJsonWeightedEndpoint(
    entry: unknown,
    validation: WeightedEndpointListValidation,
    index: number,
): WeightedEndpointConfig {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        return normalizeWeightedEndpointConfig(
            {
                url: String(record.url ?? ""),
                weight: parseEndpointWeight(record.weight, validation, index),
            },
            validation,
            index,
        );
    }
    throw new Error(
        `Invalid ${validation.key}: endpoint ${index + 1} must be an object`,
    );
}

function normalizeWeightedEndpointConfig(
    endpoint: WeightedEndpointConfig,
    validation: WeightedEndpointListValidation,
    index: number,
): WeightedEndpointConfig {
    const url = endpoint.url.trim();
    if (url.length === 0) {
        throw new Error(
            `Invalid ${validation.key}: endpoint ${index + 1} URL is empty`,
        );
    }
    assertEndpointUrl(url, validation, index);
    return {
        url,
        weight: parseEndpointWeight(endpoint.weight, validation, index),
    };
}

function assertEndpointUrl(
    url: string,
    validation: WeightedEndpointListValidation,
    index: number,
): void {
    if (!validation.explicitSchemePattern.test(url)) {
        throw new Error(
            `Invalid ${validation.key}: endpoint ${index + 1} URL is invalid`,
        );
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(
            `Invalid ${validation.key}: endpoint ${index + 1} URL is invalid`,
        );
    }
    if (
        validation.allowedProtocols.length > 0 &&
        (!validation.allowedProtocols.includes(parsed.protocol) ||
            parsed.hostname.trim().length === 0)
    ) {
        throw new Error(
            `Invalid ${validation.key}: endpoint ${index + 1} must use ${validation.protocolLabel}`,
        );
    }
}

function parseEndpointWeight(
    value: unknown,
    validation: WeightedEndpointListValidation,
    index: number,
): number {
    const raw =
        value === undefined || value === "" ? DEFAULT_ENDPOINT_WEIGHT : value;
    const weight = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isInteger(weight) || weight <= 0) {
        throw new Error(
            `Invalid ${validation.key}: endpoint ${index + 1} weight must be a positive integer`,
        );
    }
    return weight;
}
