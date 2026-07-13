export const RUNTIME_BUILD_PROFILE = Object.freeze({
    FULL: "full",
    DESKTOP: "desktop",
});

export const RUNTIME_BUILD_PROFILE_MARKER_FILE_NAME =
    ".artgod-runtime-build-profile.json";
export const RUNTIME_BUILD_PROFILE_MARKER_VERSION = 1;
export const DESKTOP_RUNTIME_EXPORT_CONDITION = "artgod-desktop-runtime";
const ESBUILD_MODULE_EXPORT_CONDITION = "module";

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
    Object.freeze({
        packageName: "@opentelemetry/*",
        pathFragments: Object.freeze([
            "/node_modules/@opentelemetry/",
            "@opentelemetry-",
        ]),
    }),
    Object.freeze({
        packageName: "prom-client",
        pathFragments: Object.freeze([
            "/node_modules/prom-client/",
            "prom-client-npm-",
        ]),
    }),
]);

// Full exporter adapters must never enter the desktop graph, even through relative imports.
export const DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_IMPLEMENTATIONS =
    Object.freeze([
        Object.freeze({
            name: "full APM adapter",
            pathSuffix: "/shared/observability/apm.ts",
        }),
        Object.freeze({
            name: "full metrics adapter",
            pathSuffix: "/shared/observability/metrics/index.ts",
        }),
        Object.freeze({
            name: "Prometheus metrics adapter",
            pathSuffix: "/shared/observability/metrics/prometheus.ts",
        }),
        Object.freeze({
            name: "metrics server adapter",
            pathSuffix: "/shared/observability/metrics/server.ts",
        }),
        Object.freeze({
            name: "runtime metrics adapter",
            pathSuffix: "/shared/observability/metrics/runtime.ts",
        }),
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

// Rejects exporter packages if they enter a desktop artifact through any path.
export function validateRuntimeBuildMetafile(profile, artifact, metafile) {
    if (requireRuntimeBuildProfile(profile) !== RUNTIME_BUILD_PROFILE.DESKTOP) {
        return;
    }

    const matches = new Map();
    for (const inputPath of Object.keys(metafile.inputs ?? {})) {
        const normalizedInputPath = `/${inputPath.replaceAll("\\", "/")}`;
        for (const excludedPackage of DESKTOP_RUNTIME_EXCLUDED_OBSERVABILITY_PACKAGES) {
            if (
                excludedPackage.pathFragments.some((fragment) =>
                    normalizedInputPath.includes(fragment),
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
            if (normalizedInputPath.endsWith(implementation.pathSuffix)) {
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
