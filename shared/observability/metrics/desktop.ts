import { noopMetrics } from "./noop.js";
import type { PrometheusMetricsOptions } from "./prometheus.js";
import type { RuntimeMetricsConfig, RuntimeMetricsHandle } from "./runtime.js";
import type { MetricsServerConfig } from "./server.js";

export * from "./types.js";
export * from "./noop.js";
export type { PrometheusMetricsOptions } from "./prometheus.js";
export type { RuntimeMetricsConfig, RuntimeMetricsHandle } from "./runtime.js";
export type { MetricsServerConfig } from "./server.js";

// Prevents the desktop graph from loading the Prometheus implementation.
export async function createPrometheusMetrics(
    _options: PrometheusMetricsOptions = {},
): Promise<null> {
    return null;
}

// Keeps the metrics server boundary inert in desktop runtime artifacts.
export async function startMetricsServer(
    _config: MetricsServerConfig,
): Promise<() => Promise<void>> {
    return async () => {};
}

// Keeps desktop metric calls inert without embedding Prometheus code.
export async function initRuntimeMetrics(
    _config: RuntimeMetricsConfig,
): Promise<RuntimeMetricsHandle> {
    return {
        metrics: noopMetrics,
        stop: async () => {},
    };
}
