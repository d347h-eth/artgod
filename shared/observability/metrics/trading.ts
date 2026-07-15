// Exposes the Prometheus runtime only to the trading desktop artifact.
export { noopMetrics } from "./noop.js";
export {
    initRuntimeMetrics,
    RUNTIME_METRIC_DEFAULT_LABEL,
    type RuntimeMetricsConfig,
    type RuntimeMetricsHandle,
} from "./runtime.js";
