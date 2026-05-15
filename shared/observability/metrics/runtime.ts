import { logger } from "../../utils/logger.js";
import { noopMetrics } from "./noop.js";
import { createPrometheusMetrics } from "./prometheus.js";
import { startMetricsServer } from "./server.js";
import type { Metrics } from "./types.js";

export type RuntimeMetricsConfig = {
    enabled: boolean;
    host: string;
    port: number;
    prefix?: string;
    worker: string;
    chainId: number;
    logComponent?: string;
};

export type RuntimeMetricsHandle = {
    metrics: Metrics;
    stop: () => Promise<void>;
};

export async function initRuntimeMetrics(
    config: RuntimeMetricsConfig,
): Promise<RuntimeMetricsHandle> {
    if (!config.enabled) {
        return {
            metrics: noopMetrics,
            stop: async () => {},
        };
    }

    const metrics = await createPrometheusMetrics({
        prefix: config.prefix,
        defaultLabels: {
            worker: config.worker,
            chain_id: String(config.chainId),
        },
    });
    if (!metrics) {
        logger.warn("Metrics disabled (prom-client unavailable)", {
            component: metricsLogComponent(config),
            action: "initRuntimeMetrics",
            worker: config.worker,
            reason: "missing_prom_client",
        });
        return {
            metrics: noopMetrics,
            stop: async () => {},
        };
    }

    const stop = await startMetricsServer({
        host: config.host,
        port: config.port,
        scrape: metrics,
    });

    logger.info("Metrics endpoint ready", {
        component: metricsLogComponent(config),
        action: "initRuntimeMetrics",
        worker: config.worker,
        host: config.host,
        port: config.port,
    });

    return {
        metrics,
        stop,
    };
}

function metricsLogComponent(config: RuntimeMetricsConfig): string {
    return config.logComponent ?? "RuntimeMetrics";
}
