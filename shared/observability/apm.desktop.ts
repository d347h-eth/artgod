import {
    NOOP_APM,
    type RuntimeApmConfig,
    type RuntimeApmHandle,
} from "./apm-contract.js";

export {
    NOOP_APM,
    type ApmPort,
    type RuntimeApmConfig,
    type RuntimeApmHandle,
    type SpanAttributes,
    type SpanAttributeValue,
} from "./apm-contract.js";

// Keeps desktop application instrumentation calls inert without exporter code.
export async function initRuntimeApm(
    _config: RuntimeApmConfig,
): Promise<RuntimeApmHandle> {
    return {
        apm: NOOP_APM,
        stop: async () => {},
    };
}
