import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Store queries use the identity passed to this launch's child. Time windows
// still account for ingestion delay, but cannot admit earlier probe identities.
export async function verifyComposeSignals(
    endpoints,
    probe,
    startedAt,
    {
        fetch: fetchStore = globalThis.fetch,
        now = Date.now,
        pause = delay,
        log = console.log,
    } = {},
) {
    // Query the stores, so an HTTP ingest acknowledgement alone cannot pass.
    // API contracts: grafana.com/docs/tempo/latest/api_docs/ and
    // github.com/grafana/pyroscope/blob/main/api/querier/v1/querier.proto.
    const metricsQuery = new URL("/api/v1/query", endpoints.prometheus);
    const traceQuery = new URL("/api/search", endpoints.tempo);
    traceQuery.searchParams.set("tags", `service.name=${probe.serviceName}`);
    traceQuery.searchParams.set("start", String(Math.floor(startedAt / 1000)));
    const deadline = now() + 45_000;
    let lastError;
    do {
        try {
            const getJson = async (url, options = {}) => {
                const response = await fetchStore(url, {
                    ...options,
                    signal: AbortSignal.timeout(5_000),
                });
                assert.ok(
                    response.ok,
                    `Collector query failed with HTTP ${response.status}`,
                );
                return response.json();
            };
            const windowSeconds = Math.max(
                1,
                Math.ceil((now() - startedAt) / 1000),
            );
            metricsQuery.searchParams.set(
                "query",
                `max_over_time(process_cpu_user_seconds_total{worker="${probe.worker}"}[${windowSeconds}s])`,
            );
            const metrics = await getJson(metricsQuery);
            assert.equal(metrics.status, "success");
            assert.ok(
                metrics.data.result.some(
                    (entry) =>
                        entry.metric.worker === probe.worker &&
                        Number(entry.value[1]) > 0,
                ),
                "Prometheus must scrape this probe's process metrics",
            );
            traceQuery.searchParams.set("end", String(Math.ceil(now() / 1000)));
            const traces = await getJson(traceQuery);
            assert.ok(
                traces.traces?.some(
                    (trace) =>
                        trace.rootServiceName === probe.serviceName &&
                        trace.rootTraceName === probe.spanName,
                ),
                "Tempo must return this probe's exported trace",
            );
            const profiles = await getJson(
                new URL(
                    "/querier.v1.QuerierService/SelectMergeStacktraces",
                    endpoints.pyroscope,
                ),
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        profileTypeID: probe.profileType,
                        labelSelector: `{service_name="${probe.serviceName}"}`,
                        start: startedAt,
                        end: now(),
                    }),
                },
            );
            assert.ok(
                Number(profiles.flamegraph?.total) > 0,
                "Pyroscope must return this probe's nonempty profile samples",
            );
            log(
                "Compose returned scraped process metrics, the probe trace and nonempty wall profile samples.",
            );
            return;
        } catch (error) {
            lastError = error;
            await pause(2_000);
        }
    } while (now() < deadline);
    throw lastError;
}
