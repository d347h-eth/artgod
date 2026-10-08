import assert from "node:assert/strict";
import test from "node:test";
import {
    createLocalDesktopProbe,
    LOCAL_DESKTOP_PROBE,
} from "./local-desktop-observability-probe-contract.mjs";
import { verifyComposeSignals } from "./local-desktop-observability-signals.mjs";

const endpoints = {
    prometheus: "http://collector-fixture.invalid",
    tempo: "http://collector-fixture.invalid",
    pyroscope: "http://collector-fixture.invalid",
};
const startedAt = 1_791_460_800_500;

test("each child has a distinct identity reproducible from its argument", () => {
    const first = createLocalDesktopProbe();
    const second = createLocalDesktopProbe();
    assert.notEqual(first.worker, second.worker);
    assert.notEqual(first.serviceName, second.serviceName);
    assert.deepEqual(createLocalDesktopProbe(first.runId), first);
    assert.equal(first.chainId, LOCAL_DESKTOP_PROBE.chainId);
    assert.equal(first.spanName, LOCAL_DESKTOP_PROBE.spanName);
    for (const value of [null, "", 'worker"}', "not-a-uuid"])
        assert.throws(() => createLocalDesktopProbe(value), /UUID identity/);
});

test("queries all three stores for this launch and accepts its signals", async () => {
    const fixture = storedSignals();
    await fixture.verify();
    assert.equal(fixture.successes.length, 1);
    assert.equal(fixture.requests.length, 3);
});

for (const [signal, description] of [
    ["metrics", "metrics sample"],
    ["trace", "trace"],
    ["profile", "profile"],
]) {
    test(`rejects an earlier ${description} when this launch's signal is absent`, async () => {
        const fixture = storedSignals(signal);
        await assert.rejects(fixture.verify(), {
            message: {
                metrics: "Prometheus must scrape this probe's process metrics",
                trace: "Tempo must return this probe's exported trace",
                profile:
                    "Pyroscope must return this probe's nonempty profile samples",
            }[signal],
        });
        assert.deepEqual(fixture.successes, []);
    });
}

function storedSignals(missing) {
    const probe = createLocalDesktopProbe();
    const previous = createLocalDesktopProbe();
    let time = startedAt + 15_100;
    const requests = [];
    const successes = [];
    const dependencies = {
        now: () => time,
        pause: async (milliseconds) => {
            time += milliseconds;
        },
        log: (message) => successes.push(message),
        async fetch(input, options) {
            const url = new URL(input);
            requests.push(url.pathname);
            let result;
            if (url.pathname === "/api/v1/query") {
                const query = url.searchParams.get("query");
                assert.ok(query.includes(`worker="${probe.worker}"`));
                // The prior sample is inside the original rounded range.
                const seconds = Number(query.match(/\[(\d+)s\]/)[1]);
                assert.ok(startedAt - 100 > time - seconds * 1000);
                const worker =
                    missing === "metrics" ? previous.worker : probe.worker;
                result = {
                    status: "success",
                    data: {
                        result: [
                            { metric: { worker }, value: [time / 1000, "1"] },
                        ],
                    },
                };
            } else if (url.pathname === "/api/search") {
                assert.equal(
                    url.searchParams.get("tags"),
                    `service.name=${probe.serviceName}`,
                );
                assert.ok(
                    startedAt - 100 >=
                        Number(url.searchParams.get("start")) * 1000,
                );
                result = {
                    traces: [
                        {
                            rootServiceName:
                                missing === "trace"
                                    ? previous.serviceName
                                    : probe.serviceName,
                            rootTraceName: probe.spanName,
                            startTimeUnixNano: String(
                                BigInt(
                                    missing === "trace"
                                        ? startedAt - 15_100
                                        : startedAt + 100,
                                ) * 1_000_000n,
                            ),
                            durationMs: 15_000,
                        },
                    ],
                };
            } else if (
                url.pathname ===
                "/querier.v1.QuerierService/SelectMergeStacktraces"
            ) {
                const query = JSON.parse(options.body);
                assert.equal(
                    query.labelSelector,
                    `{service_name="${probe.serviceName}"}`,
                );
                assert.equal(query.profileTypeID, probe.profileType);
                assert.equal(query.start, startedAt);
                // Simulate selector filtering: an earlier worker's profile
                // remains stored, but cannot satisfy this launch's query.
                const storedService =
                    missing === "profile"
                        ? previous.serviceName
                        : probe.serviceName;
                result = {
                    flamegraph: {
                        total:
                            query.labelSelector ===
                            `{service_name="${storedService}"}`
                                ? 1
                                : 0,
                    },
                };
            } else assert.fail(`Unexpected fixture request: ${url.pathname}`);
            return { ok: true, status: 200, json: async () => result };
        },
    };
    return {
        requests,
        successes,
        verify: () =>
            verifyComposeSignals(endpoints, probe, startedAt, dependencies),
    };
}
