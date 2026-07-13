import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_IMPLEMENTATIONS,
    DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_PACKAGES,
    DESKTOP_RUNTIME_EXPORT_CONDITION,
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

test("maps desktop observability exports to no-op adapters", async () => {
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
    assert.match(observabilityIndex, /from "\.\/apm\.js"/);
    assert.match(desktopObservabilityIndex, /from "\.\/apm\.desktop\.js"/);
    assert.doesNotMatch(desktopObservabilityIndex, /from "\.\/apm\.js"/);
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
