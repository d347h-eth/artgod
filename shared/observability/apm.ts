import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { logger } from "../utils/logger.js";
import {
    NOOP_APM,
    type ApmPort,
    type RuntimeApmConfig,
    type RuntimeApmHandle,
    type SpanAttributes,
} from "./apm-contract.js";

export {
    NOOP_APM,
    type ApmPort,
    type RuntimeApmConfig,
    type RuntimeApmHandle,
    type SpanAttributes,
    type SpanAttributeValue,
} from "./apm-contract.js";

type TracingRuntime = {
    shutdown: () => Promise<void>;
    withSpan: ApmPort["withSpan"];
    withSyncSpan: ApmPort["withSyncSpan"];
};

type ProfilingRuntime = {
    stop?: () => void;
    runWithLabels?: <T>(
        labels: Record<string, string>,
        run: () => Promise<T>,
    ) => Promise<T>;
};

type OTelModule = {
    trace: {
        getTracer: (name: string) => {
            startActiveSpan: <T>(
                spanName: string,
                options: {
                    attributes: Record<string, string | number | boolean>;
                },
                callback: (span: OTelSpan) => T,
            ) => T;
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
    spanContext?: () => {
        spanId?: string;
    };
    recordException?: (error: unknown) => void;
    end: () => void;
};

type OTelNodeSdk = {
    start: () => Promise<void>;
    shutdown: () => Promise<void>;
};

type PnpApi = {
    resolveRequest: (request: string, issuer: string) => string | null;
};

let cachedPnpApi: PnpApi | null | undefined;

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

    if (config.profiles.enabled) {
        profiling = await startProfiling(config);
    }
    if (config.traces.enabled) {
        tracing = await startTracing(config, profiling);
    }

    if (!tracing && !profiling) {
        logger.warn("APM enabled but no runtime initialized", {
            component: apmLogComponent(config),
            action: "initRuntimeApm",
            worker: config.worker,
            chainId: config.chainId,
            tracesEnabled: config.traces.enabled,
            profilesEnabled: config.profiles.enabled,
        });
    }

    return {
        apm: tracing
            ? {
                  withSpan: tracing.withSpan,
                  withSyncSpan: tracing.withSyncSpan,
              }
            : NOOP_APM,
        stop: async () => {
            if (profiling?.stop) {
                try {
                    profiling.stop();
                } catch (error) {
                    logger.warn("APM profiling stop failed", {
                        component: apmLogComponent(config),
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
    profiling: ProfilingRuntime | null,
): Promise<TracingRuntime | null> {
    try {
        const [sdkModule, exporterModule, otelModule] = await Promise.all([
            importModule("@opentelemetry/sdk-node"),
            importModule("@opentelemetry/exporter-trace-otlp-http"),
            importModule("@opentelemetry/api"),
        ]);
        if (!sdkModule || !exporterModule || !otelModule) {
            logger.warn("Tracing disabled (OpenTelemetry packages missing)", {
                component: apmLogComponent(config),
                action: "startTracing",
                worker: config.worker,
                chainId: config.chainId,
            });
            return null;
        }

        const sdkRuntime = sdkModule.default ?? sdkModule;
        const exporterRuntime = exporterModule.default ?? exporterModule;
        const NodeSDK = sdkRuntime.NodeSDK as
            | (new (args: {
                  serviceName?: string;
                  traceExporter: unknown;
                  autoDetectResources?: boolean;
              }) => OTelNodeSdk)
            | undefined;
        const OTLPTraceExporter = exporterRuntime.OTLPTraceExporter as
            | (new (args: { url: string }) => unknown)
            | undefined;
        const otel = otelModule as OTelModule;

        if (!NodeSDK || !OTLPTraceExporter || !otel.trace?.getTracer) {
            logger.warn("Tracing disabled (OpenTelemetry API mismatch)", {
                component: apmLogComponent(config),
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
            component: apmLogComponent(config),
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
                const tracer = otel.trace.getTracer(
                    config.tracerName ?? "artgod.runtime",
                );
                return tracer.startActiveSpan(
                    name,
                    { attributes: toOtelAttributes(attributes) },
                    async (span) => {
                        const spanId = getSpanId(span);
                        const shouldLinkProfiles =
                            config.spanProfiles.enabled &&
                            Boolean(spanId) &&
                            Boolean(profiling?.runWithLabels);
                        const runWithProfileLabels =
                            shouldLinkProfiles && spanId
                                ? () =>
                                      profiling!.runWithLabels!(
                                          buildSpanProfileLabels(
                                              config,
                                              spanId,
                                          ),
                                          run,
                                      )
                                : run;

                        try {
                            if (shouldLinkProfiles && spanId) {
                                span.setAttributes?.({
                                    "pyroscope.profile.id": spanId,
                                });
                            }
                            const result = await runWithProfileLabels();
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
            withSyncSpan: <T>(
                name: string,
                attributes: SpanAttributes,
                run: () => T,
            ): T => {
                const tracer = otel.trace.getTracer(
                    config.tracerName ?? "artgod.runtime",
                );
                return tracer.startActiveSpan(
                    name,
                    { attributes: toOtelAttributes(attributes) },
                    (span) => {
                        try {
                            const result = run();
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
                ) as T;
            },
        };
    } catch (error) {
        logger.warn("Tracing disabled (OpenTelemetry init failed)", {
            component: apmLogComponent(config),
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
                component: apmLogComponent(config),
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
        const wrapWithLabels = pyroscope.wrapWithLabels as
            | ((
                  labels: Record<string, string>,
                  fn: () => unknown,
                  ...args: unknown[]
              ) => void)
            | undefined;

        if (!init || !start) {
            logger.warn("Profiling disabled (Pyroscope API mismatch)", {
                component: apmLogComponent(config),
                action: "startProfiling",
                worker: config.worker,
                chainId: config.chainId,
            });
            return null;
        }

        const serviceName = `${config.serviceNamespace}.${config.worker}`;

        init({
            serverAddress: config.profiles.pyroscopeUrl,
            appName: serviceName,
            tags: {
                service_name: serviceName,
                worker: config.worker,
                chain_id: String(config.chainId),
            },
            wall: {
                collectCpuTime: true,
            },
        });
        start();

        logger.info("Profiling runtime ready", {
            component: apmLogComponent(config),
            action: "startProfiling",
            worker: config.worker,
            chainId: config.chainId,
            endpoint: config.profiles.pyroscopeUrl,
        });

        return {
            stop,
            runWithLabels:
                wrapWithLabels !== undefined
                    ? async <T>(
                          labels: Record<string, string>,
                          run: () => Promise<T>,
                      ): Promise<T> => {
                          let runPromise: Promise<T> | null = null;
                          wrapWithLabels(labels, () => {
                              try {
                                  runPromise = Promise.resolve(run());
                              } catch (error) {
                                  runPromise = Promise.reject(error);
                              }
                          });
                          if (!runPromise) {
                              return run();
                          }
                          return runPromise;
                      }
                    : undefined,
        };
    } catch (error) {
        logger.warn("Profiling disabled (Pyroscope init failed)", {
            component: apmLogComponent(config),
            action: "startProfiling",
            worker: config.worker,
            chainId: config.chainId,
            error: String(error),
        });
        return null;
    }
}

type OptionalApmPackage =
    | "@opentelemetry/sdk-node"
    | "@opentelemetry/exporter-trace-otlp-http"
    | "@opentelemetry/api"
    | "@pyroscope/nodejs";

async function importModule(name: OptionalApmPackage): Promise<any | null> {
    try {
        switch (name) {
            case "@opentelemetry/sdk-node":
                return await import("@opentelemetry/sdk-node");
            case "@opentelemetry/exporter-trace-otlp-http":
                return await import("@opentelemetry/exporter-trace-otlp-http");
            case "@opentelemetry/api":
                return await import("@opentelemetry/api");
            case "@pyroscope/nodejs":
                return await importPyroscopeModule();
        }
    } catch {
        return null;
    }
}

async function importPyroscopeModule(): Promise<any | null> {
    const resolved = resolveFromSharedPackage("@pyroscope/nodejs");
    if (resolved) {
        return await import(pathToFileURL(resolved).href);
    }

    const packageName = "@pyroscope/nodejs";
    return await import(packageName);
}

function resolveFromSharedPackage(packageName: string): string | null {
    const pnpApi = loadPnpApi();
    if (!pnpApi) return null;

    // Resolve native optional packages from the shared package that owns them.
    for (const issuer of sharedPackageIssuerCandidates()) {
        try {
            const resolved = pnpApi.resolveRequest(packageName, issuer);
            if (resolved) return resolved;
        } catch {
            continue;
        }
    }
    return null;
}

function loadPnpApi(): PnpApi | null {
    if (cachedPnpApi !== undefined) return cachedPnpApi;

    try {
        const runtimeRequire = createRequire(import.meta.url);
        const packageName = "pnpapi";
        cachedPnpApi = runtimeRequire(packageName) as PnpApi;
    } catch {
        cachedPnpApi = null;
    }
    return cachedPnpApi;
}

function sharedPackageIssuerCandidates(): string[] {
    const modulePath = fileURLToPath(import.meta.url);
    return [
        modulePath,
        join(process.cwd(), "shared", "observability", "apm.js"),
        join(process.cwd(), "..", "shared", "observability", "apm.js"),
        join(
            dirname(modulePath),
            "..",
            "..",
            "shared",
            "observability",
            "apm.js",
        ),
    ];
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

function getSpanId(span: OTelSpan): string | null {
    const value = span.spanContext?.().spanId;
    if (typeof value !== "string" || value.length === 0) {
        return null;
    }
    return value;
}

function buildSpanProfileLabels(
    config: RuntimeApmConfig,
    spanId: string,
): Record<string, string> {
    return {
        profile_id: spanId,
        worker: config.worker,
        chain_id: String(config.chainId),
        service_name: `${config.serviceNamespace}.${config.worker}`,
    };
}

function apmLogComponent(config: RuntimeApmConfig): string {
    return config.logComponent ?? "RuntimeApm";
}
