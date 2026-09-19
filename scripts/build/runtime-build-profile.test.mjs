import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_IMPLEMENTATIONS,
    DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_PACKAGES,
    DESKTOP_RUNTIME_EXPORT_CONDITION,
    DESKTOP_TRADING_METRICS_ALLOWED_OBSERVABILITY_PACKAGES,
    RUNTIME_ARTIFACT,
    RUNTIME_BUILD_PROFILE,
    RUNTIME_BUILD_PROFILE_MARKER_VERSION,
    parseRuntimeBuildProfileMarker,
    resolveRuntimeBuildProfile,
    runtimeBuildConditions,
    runtimeBuildProfileMarkerSource,
    validateRuntimeBuildMetafile,
} from "./runtime-build-profile.mjs";

test("defaults runtime artifacts to the full local and deploy graph", () => {
    assert.equal(resolveRuntimeBuildProfile([]), RUNTIME_BUILD_PROFILE.FULL);
    assert.equal(runtimeBuildConditions(RUNTIME_BUILD_PROFILE.FULL), undefined);
});

test("selects the conditional desktop runtime graph explicitly", () => {
    assert.equal(
        resolveRuntimeBuildProfile([
            "--profile",
            RUNTIME_BUILD_PROFILE.DESKTOP,
        ]),
        RUNTIME_BUILD_PROFILE.DESKTOP,
    );
    assert.deepEqual(runtimeBuildConditions(RUNTIME_BUILD_PROFILE.DESKTOP), [
        DESKTOP_RUNTIME_EXPORT_CONDITION,
        "module",
    ]);
});

test("rejects ambiguous and unsupported runtime build profiles", () => {
    assert.throws(
        () => resolveRuntimeBuildProfile(["--profile", "unsupported"]),
        /Invalid runtime build profile/,
    );
    assert.throws(
        () =>
            resolveRuntimeBuildProfile([
                "--profile=desktop",
                "--profile=desktop",
            ]),
        /only once/,
    );
    assert.throws(
        () => resolveRuntimeBuildProfile(["--unknown"]),
        /Unknown runtime build argument/,
    );
});

test("rejects every excluded observability package in desktop metafiles", () => {
    const inputs = Object.fromEntries(
        DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_PACKAGES.map(
            ({ packageName, pathFragments }) => [
                `/workspace/.yarn/cache/${pathFragments.at(-1)}fixture/node_modules/index.js`,
                { bytes: packageName.length, imports: [] },
            ],
        ),
    );

    assert.throws(
        () =>
            validateRuntimeBuildMetafile(
                RUNTIME_BUILD_PROFILE.DESKTOP,
                "fixture",
                { inputs },
            ),
        (error) => {
            assert.match(
                error.message,
                /excluded observability packages or implementation inputs/,
            );
            for (const {
                packageName,
            } of DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_PACKAGES) {
                assert.match(
                    error.message,
                    new RegExp(escapeRegex(packageName)),
                );
            }
            return true;
        },
    );

    assert.doesNotThrow(() =>
        validateRuntimeBuildMetafile(RUNTIME_BUILD_PROFILE.FULL, "fixture", {
            inputs,
        }),
    );
});

test("rejects full exporter adapters and unresolved imports in desktop metafiles", () => {
    for (const implementation of DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_IMPLEMENTATIONS) {
        assert.throws(
            () =>
                validateRuntimeBuildMetafile(
                    RUNTIME_BUILD_PROFILE.DESKTOP,
                    "fixture",
                    {
                        inputs: {
                            [`/workspace${implementation.pathSuffix}`]: {
                                bytes: 1,
                                imports: [],
                            },
                        },
                    },
                ),
            new RegExp(escapeRegex(implementation.name)),
        );
    }

    assert.throws(
        () =>
            validateRuntimeBuildMetafile(
                RUNTIME_BUILD_PROFILE.DESKTOP,
                "fixture",
                {
                    inputs: {},
                    outputs: {
                        "dist-desktop/server.mjs": {
                            imports: [
                                {
                                    path: "@pyroscope/nodejs",
                                    external: true,
                                },
                            ],
                        },
                    },
                },
            ),
        /@pyroscope\/nodejs/,
    );
});

test("allows only the facade-reachable Prometheus graph in the trading desktop artifact", () => {
    const metafile = createTradingMetricsMetafile();

    assert.doesNotThrow(() =>
        validateRuntimeBuildMetafile(
            RUNTIME_BUILD_PROFILE.DESKTOP,
            RUNTIME_ARTIFACT.Trading,
            metafile,
        ),
    );
    for (const artifact of [
        RUNTIME_ARTIFACT.Backend,
        RUNTIME_ARTIFACT.Indexer,
    ]) {
        assert.throws(
            () =>
                validateRuntimeBuildMetafile(
                    RUNTIME_BUILD_PROFILE.DESKTOP,
                    artifact,
                    metafile,
                ),
            /prom-client/,
        );
    }
});

test("rejects trading metrics imports that bypass the facade", () => {
    const metafile = createTradingMetricsMetafile();
    metafile.inputs["trading/src/runtime/unreviewed-metrics.ts"] = {
        bytes: 1,
        imports: [
            {
                path: "shared/observability/metrics/prometheus.ts",
                kind: "import-statement",
            },
        ],
    };

    assert.throws(
        () =>
            validateRuntimeBuildMetafile(
                RUNTIME_BUILD_PROFILE.DESKTOP,
                RUNTIME_ARTIFACT.Trading,
                metafile,
            ),
        /Prometheus metrics adapter/,
    );
});

test("keeps the metrics barrel and OpenTelemetry SDKs out of trading", () => {
    const metricsBarrelMetafile = createTradingMetricsMetafile();
    metricsBarrelMetafile.inputs[
        "shared/observability/metrics/trading.ts"
    ].imports.push({
        path: "shared/observability/metrics/index.ts",
        kind: "import-statement",
    });
    metricsBarrelMetafile.inputs["shared/observability/metrics/index.ts"] = {
        bytes: 1,
        imports: [],
    };
    assert.throws(
        () =>
            validateRuntimeBuildMetafile(
                RUNTIME_BUILD_PROFILE.DESKTOP,
                RUNTIME_ARTIFACT.Trading,
                metricsBarrelMetafile,
            ),
        /full metrics adapter/,
    );

    for (const packageName of [
        "@opentelemetry/sdk-node",
        "@opentelemetry/exporter-trace-otlp-http",
    ]) {
        const openTelemetryMetafile = createTradingMetricsMetafile();
        const packageInput = openTelemetryPackageInputPath(packageName);
        openTelemetryMetafile.inputs[
            packageInputPath(
                DESKTOP_TRADING_METRICS_ALLOWED_OBSERVABILITY_PACKAGES[0],
            )
        ].imports.push({
            path: packageInput,
            kind: "import-statement",
        });
        openTelemetryMetafile.inputs[packageInput] = {
            bytes: 1,
            imports: [],
        };
        assert.throws(
            () =>
                validateRuntimeBuildMetafile(
                    RUNTIME_BUILD_PROFILE.DESKTOP,
                    RUNTIME_ARTIFACT.Trading,
                    openTelemetryMetafile,
                ),
            /@opentelemetry\/\*/,
        );
    }
});

test("round-trips the versioned runtime profile marker", () => {
    const source = runtimeBuildProfileMarkerSource(
        RUNTIME_BUILD_PROFILE.DESKTOP,
    );
    assert.deepEqual(JSON.parse(source), {
        version: RUNTIME_BUILD_PROFILE_MARKER_VERSION,
        profile: RUNTIME_BUILD_PROFILE.DESKTOP,
    });
    assert.equal(
        parseRuntimeBuildProfileMarker(source, "fixture marker"),
        RUNTIME_BUILD_PROFILE.DESKTOP,
    );
    assert.throws(
        () =>
            parseRuntimeBuildProfileMarker(
                JSON.stringify({
                    version: RUNTIME_BUILD_PROFILE_MARKER_VERSION + 1,
                    profile: RUNTIME_BUILD_PROFILE.DESKTOP,
                }),
                "fixture marker",
            ),
        /expected marker version/,
    );
});

test("keeps general desktop observability no-op and exposes narrow trading metrics", async () => {
    const packageManifest = JSON.parse(
        await readFile(new URL("../../shared/package.json", import.meta.url)),
    );
    const observabilityIndex = await readFile(
        new URL("../../shared/observability/index.ts", import.meta.url),
        "utf8",
    );
    const desktopObservabilityIndex = await readFile(
        new URL("../../shared/observability/index.desktop.ts", import.meta.url),
        "utf8",
    );
    const tradingMetricsFacade = await readFile(
        new URL(
            "../../shared/observability/metrics/trading.ts",
            import.meta.url,
        ),
        "utf8",
    );

    assert.deepEqual(packageManifest.exports["./observability"], {
        [DESKTOP_RUNTIME_EXPORT_CONDITION]: "./observability/index.desktop.ts",
        default: "./observability/index.ts",
    });
    assert.deepEqual(packageManifest.exports["./observability/apm"], {
        [DESKTOP_RUNTIME_EXPORT_CONDITION]: "./observability/apm.desktop.ts",
        default: "./observability/apm.ts",
    });
    assert.deepEqual(packageManifest.exports["./observability/metrics"], {
        [DESKTOP_RUNTIME_EXPORT_CONDITION]:
            "./observability/metrics/desktop.ts",
        default: "./observability/metrics/index.ts",
    });
    assert.equal(
        packageManifest.exports["./observability/trading-metrics"],
        "./observability/metrics/trading.ts",
    );
    assert.match(observabilityIndex, /from "\.\/apm\.js"/);
    assert.match(desktopObservabilityIndex, /from "\.\/apm\.desktop\.js"/);
    assert.doesNotMatch(desktopObservabilityIndex, /from "\.\/apm\.js"/);
    assert.match(tradingMetricsFacade, /from "\.\/runtime\.js"/);
    assert.doesNotMatch(tradingMetricsFacade, /from "\.\/index\.js"/);
    assert.doesNotMatch(tradingMetricsFacade, /from "\.\.\/apm\.js"/);
});

test("routes desktop builds through the release-pruned runtime profile", async () => {
    const rootPackageManifest = JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url)),
    );
    const tauriConfig = JSON.parse(
        await readFile(
            new URL("../../src-tauri/tauri.conf.json", import.meta.url),
        ),
    );

    assert.equal(
        rootPackageManifest.scripts["build:runtime"],
        "node ./scripts/build/build-runtime-artifacts.mjs",
    );
    assert.equal(
        rootPackageManifest.scripts["build:desktop-runtime"],
        "node ./scripts/build/build-runtime-artifacts.mjs --profile desktop",
    );
    assert.match(
        rootPackageManifest.scripts["dev:composition"],
        /yarn build:desktop-runtime/,
    );
    assert.match(
        tauriConfig.build.beforeBuildCommand,
        /yarn build:desktop-runtime/,
    );
    assert.doesNotMatch(
        tauriConfig.build.beforeBuildCommand,
        /(?:^|&& )yarn build:runtime(?: |&&|$)/,
    );
});

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTradingMetricsMetafile() {
    const [promClientPackage, openTelemetryApiPackage] =
        DESKTOP_TRADING_METRICS_ALLOWED_OBSERVABILITY_PACKAGES;
    const promClientInputPath = packageInputPath(promClientPackage);
    const openTelemetryApiInputPath = packageInputPath(openTelemetryApiPackage);

    return {
        inputs: {
            "shared/observability/metrics/trading.ts": {
                bytes: 1,
                imports: [
                    {
                        path: "shared/observability/metrics/runtime.ts",
                        kind: "import-statement",
                    },
                ],
            },
            "shared/observability/metrics/runtime.ts": {
                bytes: 1,
                imports: [
                    {
                        path: "shared/observability/metrics/noop.ts",
                        kind: "import-statement",
                    },
                    {
                        path: "shared/observability/metrics/prometheus.ts",
                        kind: "import-statement",
                    },
                    {
                        path: "shared/observability/metrics/server.ts",
                        kind: "import-statement",
                    },
                ],
            },
            "shared/observability/metrics/noop.ts": {
                bytes: 1,
                imports: [],
            },
            "shared/observability/metrics/prometheus.ts": {
                bytes: 1,
                imports: [
                    {
                        path: promClientInputPath,
                        kind: "dynamic-import",
                    },
                ],
            },
            "shared/observability/metrics/server.ts": {
                bytes: 1,
                imports: [],
            },
            [promClientInputPath]: {
                bytes: 1,
                imports: [
                    {
                        path: openTelemetryApiInputPath,
                        kind: "require-call",
                    },
                ],
            },
            [openTelemetryApiInputPath]: {
                bytes: 1,
                imports: [],
            },
            "trading/src/runtime/bot-runtime.ts": {
                bytes: 1,
                imports: [
                    {
                        path: "shared/observability/metrics/trading.ts",
                        kind: "import-statement",
                    },
                ],
            },
        },
    };
}

function packageInputPath(packageDescriptor) {
    return `.yarn/cache/${packageDescriptor.pathFragments.at(-1)}fixture/node_modules/${packageDescriptor.packageName}/index.js`;
}

function openTelemetryPackageInputPath(packageName) {
    const cacheSlug = packageName.replaceAll("/", "-").replace(/^@/, "");
    return `.yarn/cache/@${cacheSlug}-npm-fixture/node_modules/${packageName}/build/src/index.js`;
}
