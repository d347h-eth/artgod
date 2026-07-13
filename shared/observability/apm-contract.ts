export type SpanAttributeValue = string | number | boolean | null | undefined;

export type SpanAttributes = Record<string, SpanAttributeValue>;

// Defines the tracing boundary consumed by runtime and application code.
export interface ApmPort {
    withSpan<T>(
        name: string,
        attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T>;
    withSyncSpan<T>(name: string, attributes: SpanAttributes, run: () => T): T;
}

// Defines runtime APM settings independently from any exporter implementation.
export type RuntimeApmConfig = {
    enabled: boolean;
    serviceNamespace: string;
    chainId: number;
    worker: string;
    logComponent?: string;
    tracerName?: string;
    spanProfiles: {
        enabled: boolean;
    };
    traces: {
        enabled: boolean;
        otlpHttpUrl: string;
    };
    profiles: {
        enabled: boolean;
        pyroscopeUrl: string;
    };
};

// Returns the tracing port and its runtime cleanup action.
export type RuntimeApmHandle = {
    apm: ApmPort;
    stop: () => Promise<void>;
};

// Preserves application behavior without initializing tracing or profiling.
export const NOOP_APM: ApmPort = {
    async withSpan<T>(
        _name: string,
        _attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T> {
        return run();
    },
    withSyncSpan<T>(
        _name: string,
        _attributes: SpanAttributes,
        run: () => T,
    ): T {
        return run();
    },
};
