import { logger } from "@artgod/shared/utils";

export type SpanAttributeValue = string | number | boolean | null | undefined;

export type SpanAttributes = Record<string, SpanAttributeValue>;

export interface ApmPort {
    withSpan<T>(
        name: string,
        attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T>;
}

export type RuntimeApmConfig = {
    enabled: boolean;
    serviceNamespace: string;
    chainId: number;
    worker: string;
    traces: {
        enabled: boolean;
        otlpHttpUrl: string;
    };
    profiles: {
        enabled: boolean;
        pyroscopeUrl: string;
    };
};

export type RuntimeApmHandle = {
    apm: ApmPort;
    stop: () => Promise<void>;
};

type TracingRuntime = {
    shutdown: () => Promise<void>;
    withSpan: ApmPort["withSpan"];
};

type ProfilingRuntime = {
    stop?: () => void;
};

type OTelModule = {
    trace: {
        getTracer: (name: string) => {
            startActiveSpan: (
                spanName: string,
                options: {
                    attributes: Record<string, string | number | boolean>;
                },
                callback: (span: OTelSpan) => Promise<unknown>,
            ) => Promise<unknown>;
        };
    };
    SpanStatusCode?: {
        OK: number;
        ERROR: number;
    };
};

type OTelSpan = {
    setStatus?: (status: { code: number; message?: string }) => void;
    setAttributes?: (
        attributes: Record<string, string | number | boolean>,
    ) => void;
    recordException?: (error: unknown) => void;
    end: () => void;
};

type OTelNodeSdk = {
    start: () => Promise<void>;
    shutdown: () => Promise<void>;
};

export const NOOP_APM: ApmPort = {
    async withSpan<T>(
        _name: string,
        _attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T> {
        return run();
    },
};

export async function initRuntimeApm(
    config: RuntimeApmConfig,
): Promise<RuntimeApmHandle> {
    if (!config.enabled) {
        return {
            apm: NOOP_APM,
            stop: async () => {},
        };
    }

    let tracing: TracingRuntime | null = null;
    let profiling: ProfilingRuntime | null = null;

    if (config.traces.enabled) {
        tracing = await startTracing(config);
    }
    if (config.profiles.enabled) {
        profiling = await startProfiling(config);
    }

    if (!tracing && !profiling) {
        logger.warn("APM enabled but no runtime initialized", {
            component: "IndexerApm",
            action: "initRuntimeApm",
            worker: config.worker,
            chainId: config.chainId,
            tracesEnabled: config.traces.enabled,
            profilesEnabled: config.profiles.enabled,
        });
    }

    return {
        apm: tracing ? { withSpan: tracing.withSpan } : NOOP_APM,
        stop: async () => {
            if (profiling?.stop) {
                try {
                    profiling.stop();
                } catch (error) {
                    logger.warn("APM profiling stop failed", {
                        component: "IndexerApm",
                        action: "stop",
                        worker: config.worker,
                        error: String(error),
                    });
                }
            }
            if (tracing) {
                await tracing.shutdown();
            }
        },
    };
}

async function startTracing(
    config: RuntimeApmConfig,
): Promise<TracingRuntime | null> {
    try {
        const [sdkModule, exporterModule, otelModule] = await Promise.all([
            importModule("@opentelemetry/sdk-node"),
            importModule("@opentelemetry/exporter-trace-otlp-http"),
            importModule("@opentelemetry/api"),
        ]);
        if (!sdkModule || !exporterModule || !otelModule) {
            logger.warn("Tracing disabled (OpenTelemetry packages missing)", {
                component: "IndexerApm",
                action: "startTracing",
                worker: config.worker,
                chainId: config.chainId,
            });
            return null;
        }

        const NodeSDK = sdkModule.NodeSDK as
            | (new (args: {
                  serviceName?: string;
                  traceExporter: unknown;
                  autoDetectResources?: boolean;
              }) => OTelNodeSdk)
            | undefined;
        const OTLPTraceExporter = exporterModule.OTLPTraceExporter as
            | (new (args: { url: string }) => unknown)
            | undefined;
        const otel = otelModule as OTelModule;

        if (!NodeSDK || !OTLPTraceExporter || !otel.trace?.getTracer) {
            logger.warn("Tracing disabled (OpenTelemetry API mismatch)", {
                component: "IndexerApm",
                action: "startTracing",
                worker: config.worker,
                chainId: config.chainId,
            });
            return null;
        }

        const serviceName = `${config.serviceNamespace}.${config.worker}`;
        const traceExporter = new OTLPTraceExporter({
            url: config.traces.otlpHttpUrl,
        });
        const sdk = new NodeSDK({
            serviceName,
            traceExporter,
            autoDetectResources: true,
        });
        await sdk.start();

        logger.info("Tracing runtime ready", {
            component: "IndexerApm",
            action: "startTracing",
            worker: config.worker,
            chainId: config.chainId,
            serviceName,
            endpoint: config.traces.otlpHttpUrl,
        });

        return {
            shutdown: () => sdk.shutdown(),
            withSpan: async <T>(
                name: string,
                attributes: SpanAttributes,
                run: () => Promise<T>,
            ): Promise<T> => {
                const tracer = otel.trace.getTracer("artgod.indexer");
                return tracer.startActiveSpan(
                    name,
                    { attributes: toOtelAttributes(attributes) },
                    async (span) => {
                        try {
                            const result = await run();
                            if (otel.SpanStatusCode?.OK !== undefined) {
                                span.setStatus?.({
                                    code: otel.SpanStatusCode.OK,
                                });
                            }
                            return result;
                        } catch (error) {
                            span.recordException?.(error);
                            if (otel.SpanStatusCode?.ERROR !== undefined) {
                                span.setStatus?.({
                                    code: otel.SpanStatusCode.ERROR,
                                    message: String(error),
                                });
                            }
                            throw error;
                        } finally {
                            span.end();
                        }
                    },
                ) as Promise<T>;
            },
        };
    } catch (error) {
        logger.warn("Tracing disabled (OpenTelemetry init failed)", {
            component: "IndexerApm",
            action: "startTracing",
            worker: config.worker,
            chainId: config.chainId,
            error: String(error),
        });
        return null;
    }
}

async function startProfiling(
    config: RuntimeApmConfig,
): Promise<ProfilingRuntime | null> {
    try {
        const pyroscopeModule = await importModule("@pyroscope/nodejs");
        if (!pyroscopeModule) {
            logger.warn("Profiling disabled (Pyroscope package missing)", {
                component: "IndexerApm",
                action: "startProfiling",
                worker: config.worker,
                chainId: config.chainId,
            });
            return null;
        }

        const pyroscope =
            pyroscopeModule.default ??
            pyroscopeModule.Pyroscope ??
            pyroscopeModule;
        const init = pyroscope.init as
            | ((args: {
                  serverAddress: string;
                  appName: string;
                  tags?: Record<string, string>;
                  wall?: {
                      collectCpuTime?: boolean;
                  };
              }) => void)
            | undefined;
        const start = pyroscope.start as (() => void) | undefined;
        const stop = pyroscope.stop as (() => void) | undefined;

        if (!init || !start) {
            logger.warn("Profiling disabled (Pyroscope API mismatch)", {
                component: "IndexerApm",
                action: "startProfiling",
                worker: config.worker,
                chainId: config.chainId,
            });
            return null;
        }

        init({
            serverAddress: config.profiles.pyroscopeUrl,
            appName: `${config.serviceNamespace}.${config.worker}`,
            tags: {
                worker: config.worker,
                chain_id: String(config.chainId),
            },
            wall: {
                collectCpuTime: true,
            },
        });
        start();

        logger.info("Profiling runtime ready", {
            component: "IndexerApm",
            action: "startProfiling",
            worker: config.worker,
            chainId: config.chainId,
            endpoint: config.profiles.pyroscopeUrl,
        });

        return { stop };
    } catch (error) {
        logger.warn("Profiling disabled (Pyroscope init failed)", {
            component: "IndexerApm",
            action: "startProfiling",
            worker: config.worker,
            chainId: config.chainId,
            error: String(error),
        });
        return null;
    }
}

async function importModule(name: string): Promise<any | null> {
    try {
        const packageName = name;
        return await import(packageName);
    } catch {
        return null;
    }
}

function toOtelAttributes(
    attributes: SpanAttributes,
): Record<string, string | number | boolean> {
    const normalized: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null) continue;
        if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
        ) {
            normalized[key] = value;
        } else {
            normalized[key] = String(value);
        }
    }
    return normalized;
}
