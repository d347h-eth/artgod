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

// Default admission checks all independent compiled/tested roots with one metadata cache.
export async function checkCargoDependencyAge({
    projectRoot = rootDir,
    args = parseCommonArgs([], { defaultProject: null }),
    now = new Date(),
    fetchVersions = fetchCrateVersions,
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
    const results = await mapWithConcurrency(
        packages,
        DEFAULT_CRATES_IO_METADATA_CONCURRENCY,
        async (packageEntry) => {
            const versions = await getCachedVersions(
                versionCache,
                packageEntry.name,
                fetchVersions,
            );
            const versionMetadata = findVersionMetadata(versions, packageEntry);
            if (!versionMetadata) {
                return {
                    type: "violation",
                    message: `${packageKey(packageEntry)}: current version is missing from crates.io metadata`,
                };
            }

            if (versionMetadata.createdAt <= cutoffDate) {
                return { type: "eligible" };
            }

            if (
                isFreshVersionAllowed({
                    freshVersionExceptions: policy.freshVersionExceptions,
                    now,
                    packageEntry,
                })
            ) {
                return {
                    type: "allowlisted",
                    message: `${packageKey(packageEntry)} (${describeVersionAge(
                        versionMetadata,
                        now,
                    )}; ${getFreshVersionExceptionReason({
                        freshVersionExceptions: policy.freshVersionExceptions,
                        packageEntry,
                    })})`,
                };
            }

            return {
                type: "violation",
                message: `${packageKey(packageEntry)} is ${describeVersionAge(
                    versionMetadata,
                    now,
                )}`,
            };
        },
    );
    const violations = results
        .filter((result) => result.type === "violation")
        .map((result) => result.message);
    const allowlisted = results
        .filter((result) => result.type === "allowlisted")
        .map((result) => result.message);

    return {
        packageCount: packages.length,
        projectCount: projects.length,
        minimumAgeDays: policy.minimumAgeDays,
        violations,
        allowlisted,
    };
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
        const result = await checkCargoDependencyAge({ args });
        if (result.violations.length > 0) {
            console.error(
                `Cargo age gate failed: ${result.violations.length} package version(s) are newer than ${result.minimumAgeDays} days and are not allowlisted.`,
            );
            for (const violation of result.violations)
                console.error(`- ${violation}`);
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
            for (const value of result.allowlisted) console.log(`- ${value}`);
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
