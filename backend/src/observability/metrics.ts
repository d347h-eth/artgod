import { logger } from "@artgod/shared/utils";
import {
    createPrometheusMetrics,
    noopMetrics,
    startMetricsServer,
    type Metrics,
} from "@artgod/shared/observability/metrics";

export type BackendMetricsRuntimeConfig = {
    enabled: boolean;
    host: string;
    port: number;
    chainId: number;
    deploymentMode: string;
};

export type BackendMetricsHandle = {
    metrics: Metrics;
    stop: () => Promise<void>;
};

// Starts the backend API scrape endpoint when metrics are enabled.
export async function initBackendMetrics(
    config: BackendMetricsRuntimeConfig,
): Promise<BackendMetricsHandle> {
    if (!config.enabled) {
        return {
            metrics: noopMetrics,
            stop: async () => {},
        };
    }

    const metrics = await createPrometheusMetrics({
        prefix: "artgod_backend_",
        defaultLabels: {
            service: "backend-api",
            chain_id: String(config.chainId),
            deployment_mode: config.deploymentMode,
        },
    });
    if (!metrics) {
        logger.warn("Backend metrics disabled (prom-client unavailable)", {
            component: "BackendMetrics",
            action: "initBackendMetrics",
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

    logger.info("Backend metrics endpoint ready", {
        component: "BackendMetrics",
        action: "initBackendMetrics",
        host: config.host,
        port: config.port,
    });

    return {
        metrics,
        stop,
    };
}
