import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { initRuntimeApm } from "../../shared/observability/apm.js";
import { initRuntimeMetrics } from "../../shared/observability/metrics/index.js";
import { LOCAL_DESKTOP_PROBE } from "./local-desktop-observability-probe-contract.mjs";

const [collector, port, enabledArgument] = process.argv.slice(2);
if (!collector || !port || !["true", "false"].includes(enabledArgument ?? "")) {
    throw new Error(
        "Collector URL, metrics port and explicit enabled flag are required.",
    );
}
const enabled = enabledArgument === "true";
const { worker, chainId, serviceNamespace, spanName } = LOCAL_DESKTOP_PROBE;
const metrics = await initRuntimeMetrics({
    enabled,
    host: "127.0.0.1",
    port: Number(port),
    worker,
    chainId,
    prefix: "artgod_backend_",
});
const apm = await initRuntimeApm({
    enabled,
    worker,
    chainId,
    serviceNamespace,
    traces: { enabled: true, otlpHttpUrl: `${collector}/v1/traces` },
    profiles: { enabled: true, pyroscopeUrl: collector },
    spanProfiles: { enabled: true },
});
try {
    if (enabled) {
        const response = await fetch(`http://127.0.0.1:${port}/metrics`);
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.match(body, /process_cpu_user_seconds_total/);
        assert.ok(body.includes(`worker="${worker}"`));
    } else {
        await assert.rejects(fetch(`http://127.0.0.1:${port}/metrics`));
    }
    await apm.apm.withSpan(
        spanName,
        { worker, chain_id: chainId },
        async () => {
            // Leave enough time for the existing profiler's normal upload interval.
            const until = Date.now() + (enabled ? 15_000 : 500);
            while (Date.now() < until) {
                let value = 0;
                for (let i = 0; i < 100_000; i += 1) value += Math.sqrt(i);
                assert.ok(value > 0);
                await delay(10);
            }
        },
    );
} finally {
    await apm.stop();
    await metrics.stop();
}
