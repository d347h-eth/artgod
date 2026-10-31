#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    CliUsageError,
    calculateCutoffDate,
    collectCratesIoPackages,
    DEFAULT_CARGO_AGE_GATE_CONFIG_RELATIVE_PATH,
    DEFAULT_CRATES_IO_METADATA_CONCURRENCY,
    describeVersionAge,
    fetchCrateVersions,
    filterPackagesBySelectors,
    findVersionMetadata,
    getFreshVersionExceptionReason,
    isFreshVersionAllowed,
    loadCargoAgeGatePolicy,
    mapWithConcurrency,
    packageKey,
    parseCommonArgs,
    readCargoLockPackages,
    resolveProjectPath,
} from "./cargo-age-gate-utils.mjs";

import { DESKTOP_CARGO_PROJECTS } from "../build/cargo-projects.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

export const CARGO_AGE_GATE_RESULT_TYPE = Object.freeze({
    Eligible: "eligible",
    Allowlisted: "allowlisted",
    Violation: "violation",
    Error: "error",
});

// Default admission checks all independent compiled/tested roots with one metadata cache.
// onProgress reports each deduplicated package version as it completes, including
// a failed metadata lookup before that error aborts admission.
export async function checkCargoDependencyAge({
    projectRoot = rootDir,
    args = parseCommonArgs([], { defaultProject: null }),
    now = new Date(),
    fetchVersions = fetchCrateVersions,
    onProgress,
} = {}) {
    const rootDir = projectRoot;
    const policy = await loadCargoAgeGatePolicy({
        rootDir,
        configPath: args.configPath,
        minimumAgeDaysOverride: args.minimumAgeDays,
    });
    const cutoffDate = calculateCutoffDate(now, policy.minimumAgeDays);
    const projects = args.lockfilePath
        ? [args]
        : Object.values(DESKTOP_CARGO_PROJECTS);
    const packagesByKey = new Map();
    // Read every required root before network access; missing lockfiles fail admission.
    for (const project of projects) {
        const lockfilePath = resolveProjectPath(rootDir, project.lockfilePath);
        for (const entry of collectCratesIoPackages(
            await readCargoLockPackages(lockfilePath),
        )) {
            packagesByKey.set(packageKey(entry), entry);
        }
    }
    const packages = filterPackagesBySelectors(
        [...packagesByKey.values()],
        args.packageSelectors,
    );
    const versionCache = new Map();
    let completed = 0;
    function report(packageEntry, result) {
        completed += 1;
        onProgress?.({
            completed,
            total: packages.length,
            packageEntry,
            result,
        });
        return result;
    }
    const results = await mapWithConcurrency(
        packages,
        DEFAULT_CRATES_IO_METADATA_CONCURRENCY,
        async (packageEntry) => {
            let versions;
            try {
                versions = await getCachedVersions(
                    versionCache,
                    packageEntry.name,
                    fetchVersions,
                );
            } catch (error) {
                report(packageEntry, {
                    type: CARGO_AGE_GATE_RESULT_TYPE.Error,
                    message: `${packageKey(packageEntry)}: ${error instanceof Error ? error.message : String(error)}`,
                });
                throw error;
            }
            const versionMetadata = findVersionMetadata(versions, packageEntry);
            if (!versionMetadata) {
                return report(packageEntry, {
                    type: CARGO_AGE_GATE_RESULT_TYPE.Violation,
                    message: `${packageKey(packageEntry)}: current version is missing from crates.io metadata`,
                });
            }

            if (versionMetadata.createdAt <= cutoffDate) {
                return report(packageEntry, {
                    type: CARGO_AGE_GATE_RESULT_TYPE.Eligible,
                });
            }

            if (
                isFreshVersionAllowed({
                    freshVersionExceptions: policy.freshVersionExceptions,
                    now,
                    packageEntry,
                })
            ) {
                return report(packageEntry, {
                    type: CARGO_AGE_GATE_RESULT_TYPE.Allowlisted,
                    message: `${packageKey(packageEntry)} (${describeVersionAge(
                        versionMetadata,
                        now,
                    )}; ${getFreshVersionExceptionReason({
                        freshVersionExceptions: policy.freshVersionExceptions,
                        packageEntry,
                    })})`,
                });
            }

            return report(packageEntry, {
                type: CARGO_AGE_GATE_RESULT_TYPE.Violation,
                message: `${packageKey(packageEntry)} is ${describeVersionAge(
                    versionMetadata,
                    now,
                )}`,
            });
        },
    );
    const violations = results
        .filter(
            (result) => result.type === CARGO_AGE_GATE_RESULT_TYPE.Violation,
        )
        .map((result) => result.message);
    const allowlisted = results
        .filter(
            (result) => result.type === CARGO_AGE_GATE_RESULT_TYPE.Allowlisted,
        )
        .map((result) => result.message);

    return {
        packageCount: packages.length,
        projectCount: projects.length,
        minimumAgeDays: policy.minimumAgeDays,
        violations,
        allowlisted,
    };
}

// Keep each result on one physical log line even if an exception reason or
// registry error contains line breaks. The total counts selected package
// versions, so versions sharing one metadata request still get separate lines.
export function formatCargoAgeGateProgress({
    completed,
    total,
    packageEntry,
    result,
}) {
    const percentage = ((completed / total) * 100).toFixed(1);
    const detail = result.message ?? packageKey(packageEntry);
    return `[${completed}/${total} (${percentage}%)] ${result.type}: ${detail}`.replace(
        /[\r\n]+/g,
        " ",
    );
}

async function main() {
    try {
        const args = parseCommonArgs(process.argv.slice(2), {
            defaultProject: null,
        });
        if (args.help) {
            printUsage();
            return;
        }
        const result = await checkCargoDependencyAge({
            args,
            onProgress: (progress) =>
                console.log(formatCargoAgeGateProgress(progress)),
        });
        if (result.violations.length > 0) {
            console.error(
                `Cargo age gate failed: ${result.violations.length} package version(s) are newer than ${result.minimumAgeDays} days and are not allowlisted.`,
            );
            process.exitCode = 1;
            return;
        }
        console.log(
            `Cargo age gate passed: ${result.packageCount} crates.io package version(s) across ${result.projectCount} lockfile(s) checked with a ${result.minimumAgeDays}d minimum age.`,
        );
        if (result.allowlisted.length > 0) {
            console.log(
                `Allowlisted fresh versions: ${result.allowlisted.length}`,
            );
        }
    } catch (error) {
        if (error instanceof CliUsageError) {
            console.error(error.message);
            printUsage();
            process.exitCode = 2;
            return;
        }
        throw error;
    }
}

async function getCachedVersions(versionCache, crateName, fetchVersions) {
    let versionsPromise = versionCache.get(crateName);
    if (!versionsPromise) {
        versionsPromise = fetchVersions(crateName);
        versionCache.set(crateName, versionsPromise);
    }
    return versionsPromise;
}

function printUsage() {
    console.log(`Usage: yarn cargo:age-gate [options]

Checks all maintained desktop Cargo lockfiles by default and fails if a locked
crates.io version is newer than the configured age without a policy exception.

Options:
  --config <path>          Policy file. Default: ${DEFAULT_CARGO_AGE_GATE_CONFIG_RELATIVE_PATH}
  --lockfile <path>        Limit admission to one independent Cargo root.
  --manifest-path <path>   Select one root; its adjacent lockfile is required.
  --min-age-days <days>    Override configured minimum age.
  --package <name[@ver]>   Limit to one package; repeatable.
  -h, --help               Show this help.
`);
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
    await main();
