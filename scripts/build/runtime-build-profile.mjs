export const RUNTIME_BUILD_PROFILE = Object.freeze({
    FULL: "full",
    DESKTOP: "desktop",
});

// Names each runtime artifact group validated by the desktop release build.
export const RUNTIME_ARTIFACT = Object.freeze({
    Backend: "backend",
    Indexer: "indexer",
    Trading: "trading",
});

export const RUNTIME_BUILD_PROFILE_MARKER_FILE_NAME =
    ".artgod-runtime-build-profile.json";
export const RUNTIME_BUILD_PROFILE_MARKER_VERSION = 1;
export const DESKTOP_RUNTIME_EXPORT_CONDITION = "artgod-desktop-runtime";
const ESBUILD_MODULE_EXPORT_CONDITION = "module";

const PROM_CLIENT_PACKAGE = Object.freeze({
    packageName: "prom-client",
    pathFragments: Object.freeze([
        "/node_modules/prom-client/",
        "prom-client-npm-",
    ]),
});
const OPEN_TELEMETRY_API_PACKAGE = Object.freeze({
    packageName: "@opentelemetry/api",
    pathFragments: Object.freeze([
        "/node_modules/@opentelemetry/api/",
        "@opentelemetry-api-npm-",
    ]),
});
const OPEN_TELEMETRY_PACKAGE_SCOPE = Object.freeze({
    packageName: "@opentelemetry/*",
    pathFragments: Object.freeze([
        "/node_modules/@opentelemetry/",
        "@opentelemetry-",
    ]),
});

export const DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_PACKAGES = Object.freeze([
    Object.freeze({
        packageName: "@pyroscope/nodejs",
        pathFragments: Object.freeze([
            "/node_modules/@pyroscope/nodejs/",
            "@pyroscope-nodejs-npm-",
        ]),
    }),
    Object.freeze({
        packageName: "@datadog/pprof",
        pathFragments: Object.freeze([
            "/node_modules/@datadog/pprof/",
            "@datadog-pprof-npm-",
        ]),
    }),
    OPEN_TELEMETRY_PACKAGE_SCOPE,
    PROM_CLIENT_PACKAGE,
]);

// Only this reviewed package pair may enter trading through its metrics facade.
export const DESKTOP_TRADING_METRICS_ALLOWED_OBSERVABILITY_PACKAGES =
    Object.freeze([PROM_CLIENT_PACKAGE, OPEN_TELEMETRY_API_PACKAGE]);

const FULL_APM_IMPLEMENTATION = Object.freeze({
    name: "full APM adapter",
    pathSuffix: "/shared/observability/apm.ts",
});
const FULL_METRICS_IMPLEMENTATION = Object.freeze({
    name: "full metrics adapter",
    pathSuffix: "/shared/observability/metrics/index.ts",
});
const PROMETHEUS_METRICS_IMPLEMENTATION = Object.freeze({
    name: "Prometheus metrics adapter",
    pathSuffix: "/shared/observability/metrics/prometheus.ts",
});
const METRICS_SERVER_IMPLEMENTATION = Object.freeze({
    name: "metrics server adapter",
    pathSuffix: "/shared/observability/metrics/server.ts",
});
const RUNTIME_METRICS_IMPLEMENTATION = Object.freeze({
    name: "runtime metrics adapter",
    pathSuffix: "/shared/observability/metrics/runtime.ts",
});
const TRADING_METRICS_FACADE_PATH_SUFFIX =
    "/shared/observability/metrics/trading.ts";

// These implementations stay excluded unless the narrow trading policy admits them.
export const DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_IMPLEMENTATIONS =
    Object.freeze([
        FULL_APM_IMPLEMENTATION,
        FULL_METRICS_IMPLEMENTATION,
        PROMETHEUS_METRICS_IMPLEMENTATION,
        METRICS_SERVER_IMPLEMENTATION,
        RUNTIME_METRICS_IMPLEMENTATION,
    ]);

// Trading may use only the narrow runtime path, never the full metrics barrel or APM.
export const DESKTOP_TRADING_METRICS_ALLOWED_OBSERVABILITY_IMPLEMENTATIONS =
    Object.freeze([
        PROMETHEUS_METRICS_IMPLEMENTATION,
        METRICS_SERVER_IMPLEMENTATION,
        RUNTIME_METRICS_IMPLEMENTATION,
    ]);

// Resolves the explicit artifact graph requested by the build command.
export function resolveRuntimeBuildProfile(args) {
    let profile = RUNTIME_BUILD_PROFILE.FULL;
    let profileWasProvided = false;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        let requestedProfile;

        if (argument === "--profile") {
            requestedProfile = args[index + 1];
            index += 1;
        } else if (argument.startsWith("--profile=")) {
            requestedProfile = argument.slice("--profile=".length);
        } else {
            throw new Error(`Unknown runtime build argument: ${argument}`);
        }

        if (profileWasProvided) {
            throw new Error("Runtime build profile may be provided only once.");
        }
        profile = requireRuntimeBuildProfile(requestedProfile);
        profileWasProvided = true;
    }

    return profile;
}

// Selects package export conditions only for the release-pruned desktop graph.
export function runtimeBuildConditions(profile) {
    const resolvedProfile = requireRuntimeBuildProfile(profile);
    return resolvedProfile === RUNTIME_BUILD_PROFILE.DESKTOP
        ? [DESKTOP_RUNTIME_EXPORT_CONDITION, ESBUILD_MODULE_EXPORT_CONDITION]
        : undefined;
}

// Rejects exporter packages outside the reviewed trading metrics graph.
export function validateRuntimeBuildMetafile(profile, artifact, metafile) {
    if (requireRuntimeBuildProfile(profile) !== RUNTIME_BUILD_PROFILE.DESKTOP) {
        return;
    }

    const matches = new Map();
    const tradingMetricsReachableInputPaths =
        resolveTradingMetricsReachableInputPaths(artifact, metafile);
    for (const inputPath of Object.keys(metafile.inputs ?? {})) {
        const normalizedInputPath = normalizeMetafileInputPath(inputPath);
        for (const excludedPackage of DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_PACKAGES) {
            if (
                excludedPackage.pathFragments.some((fragment) =>
                    normalizedInputPath.includes(fragment),
                ) &&
                !isAllowedTradingMetricsPackageInput(
                    artifact,
                    normalizedInputPath,
                    tradingMetricsReachableInputPaths,
                )
            ) {
                const existingMatch = matches.get(excludedPackage.packageName);
                matches.set(excludedPackage.packageName, {
                    firstInputPath: existingMatch?.firstInputPath ?? inputPath,
                    inputCount: (existingMatch?.inputCount ?? 0) + 1,
                });
            }
        }
        for (const implementation of DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_IMPLEMENTATIONS) {
            if (
                normalizedInputPath.endsWith(implementation.pathSuffix) &&
                !isAllowedTradingMetricsImplementationInput(
                    artifact,
                    normalizedInputPath,
                    tradingMetricsReachableInputPaths,
                )
            ) {
                const existingMatch = matches.get(implementation.name);
                matches.set(implementation.name, {
                    firstInputPath: existingMatch?.firstInputPath ?? inputPath,
                    inputCount: (existingMatch?.inputCount ?? 0) + 1,
                });
            }
        }
    }

    for (const [outputPath, output] of Object.entries(metafile.outputs ?? {})) {
        for (const imported of output.imports ?? []) {
            if (!imported.external) continue;
            for (const excludedPackage of DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_PACKAGES) {
                if (
                    matchesExcludedPackageSpecifier(
                        imported.path,
                        excludedPackage.packageName,
                    )
                ) {
                    const existingMatch = matches.get(
                        excludedPackage.packageName,
                    );
                    matches.set(excludedPackage.packageName, {
                        firstInputPath:
                            existingMatch?.firstInputPath ??
                            `${outputPath} imports ${imported.path}`,
                        inputCount: (existingMatch?.inputCount ?? 0) + 1,
                    });
                }
            }
        }
    }

    if (matches.size > 0) {
        const details = [...matches.entries()].map(
            ([packageName, match]) =>
                `${packageName} (${match.inputCount} inputs; first: ${match.firstInputPath})`,
        );
        throw new Error(
            `Desktop runtime artifact ${artifact} contains excluded observability packages or implementation inputs:\n- ${details.join("\n- ")}`,
        );
    }
}

function resolveTradingMetricsReachableInputPaths(artifact, metafile) {
    if (artifact !== RUNTIME_ARTIFACT.Trading) return new Set();

    const inputs = new Map(
        Object.entries(metafile.inputs ?? {}).map(([inputPath, input]) => [
            normalizeMetafileInputPath(inputPath),
            input,
        ]),
    );
    const facadeInputPath = [...inputs.keys()].find((inputPath) =>
        inputPath.endsWith(TRADING_METRICS_FACADE_PATH_SUFFIX),
    );
    if (!facadeInputPath) return new Set();

    const reachableInputPaths = new Set();
    const pendingInputPaths = [facadeInputPath];
    while (pendingInputPaths.length > 0) {
        const inputPath = pendingInputPaths.pop();
        if (!inputPath || reachableInputPaths.has(inputPath)) continue;
        reachableInputPaths.add(inputPath);

        const input = inputs.get(inputPath);
        for (const imported of input?.imports ?? []) {
            if (imported.external) continue;
            const importedInputPath = normalizeMetafileInputPath(imported.path);
            if (inputs.has(importedInputPath)) {
                pendingInputPaths.push(importedInputPath);
            }
        }
    }

    // Refuse alternate imports that bypass the reviewed facade boundary.
    for (const [inputPath, input] of inputs) {
        if (reachableInputPaths.has(inputPath)) continue;
        for (const imported of input?.imports ?? []) {
            if (imported.external) continue;
            const importedInputPath = normalizeMetafileInputPath(imported.path);
            if (
                reachableInputPaths.has(importedInputPath) &&
                importedInputPath !== facadeInputPath &&
                isTradingMetricsRestrictedInputPath(importedInputPath)
            ) {
                return new Set();
            }
        }
    }
    return reachableInputPaths;
}

function isTradingMetricsRestrictedInputPath(inputPath) {
    return (
        DESKTOP_TRADING_METRICS_ALLOWED_OBSERVABILITY_PACKAGES.some(
            ({ packageName }) =>
                matchesExactPackageInput(inputPath, packageName),
        ) ||
        DESKTOP_TRADING_METRICS_ALLOWED_OBSERVABILITY_IMPLEMENTATIONS.some(
            ({ pathSuffix }) => inputPath.endsWith(pathSuffix),
        )
    );
}

function isAllowedTradingMetricsPackageInput(
    artifact,
    inputPath,
    reachableInputPaths,
) {
    return (
        artifact === RUNTIME_ARTIFACT.Trading &&
        reachableInputPaths.has(inputPath) &&
        DESKTOP_TRADING_METRICS_ALLOWED_OBSERVABILITY_PACKAGES.some(
            ({ packageName }) =>
                matchesExactPackageInput(inputPath, packageName),
        )
    );
}

function matchesExactPackageInput(inputPath, packageName) {
    return inputPath.includes(`/node_modules/${packageName}/`);
}

function isAllowedTradingMetricsImplementationInput(
    artifact,
    inputPath,
    reachableInputPaths,
) {
    return (
        artifact === RUNTIME_ARTIFACT.Trading &&
        reachableInputPaths.has(inputPath) &&
        DESKTOP_TRADING_METRICS_ALLOWED_OBSERVABILITY_IMPLEMENTATIONS.some(
            ({ pathSuffix }) => inputPath.endsWith(pathSuffix),
        )
    );
}

function normalizeMetafileInputPath(inputPath) {
    return `/${inputPath.replaceAll("\\", "/").replace(/^\/+/, "")}`;
}

function matchesExcludedPackageSpecifier(specifier, excludedPackageName) {
    if (excludedPackageName.endsWith("/*")) {
        return specifier.startsWith(excludedPackageName.slice(0, -1));
    }
    return (
        specifier === excludedPackageName ||
        specifier.startsWith(`${excludedPackageName}/`)
    );
}

// Serializes the artifact profile contract copied into staged runtime resources.
export function runtimeBuildProfileMarkerSource(profile) {
    return `${JSON.stringify(
        {
            version: RUNTIME_BUILD_PROFILE_MARKER_VERSION,
            profile: requireRuntimeBuildProfile(profile),
        },
        null,
        4,
    )}\n`;
}

// Parses and validates the artifact profile contract before staging.
export function parseRuntimeBuildProfileMarker(
    source,
    description = "runtime build profile marker",
) {
    let marker;
    try {
        marker = JSON.parse(source);
    } catch (error) {
        throw new Error(
            `Invalid ${description}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    if (
        marker === null ||
        typeof marker !== "object" ||
        Array.isArray(marker) ||
        marker.version !== RUNTIME_BUILD_PROFILE_MARKER_VERSION
    ) {
        throw new Error(
            `Invalid ${description}: expected marker version ${RUNTIME_BUILD_PROFILE_MARKER_VERSION}.`,
        );
    }

    return requireRuntimeBuildProfile(marker.profile, description);
}

function requireRuntimeBuildProfile(
    profile,
    description = "runtime build profile",
) {
    if (
        profile !== RUNTIME_BUILD_PROFILE.FULL &&
        profile !== RUNTIME_BUILD_PROFILE.DESKTOP
    ) {
        throw new Error(
            `Invalid ${description}: expected ${RUNTIME_BUILD_PROFILE.FULL} or ${RUNTIME_BUILD_PROFILE.DESKTOP}, got ${String(profile)}.`,
        );
    }
    return profile;
}
