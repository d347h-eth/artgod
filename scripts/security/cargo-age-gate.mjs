#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    CliUsageError,
    calculateCutoffDate,
    collectCratesIoPackages,
    DEFAULT_CARGO_AGE_GATE_CONFIG_RELATIVE_PATH,
    DEFAULT_CARGO_LOCK_RELATIVE_PATH,
    DEFAULT_CARGO_MANIFEST_RELATIVE_PATH,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

try {
    const args = parseCommonArgs(process.argv.slice(2));
    if (args.help) {
        printUsage();
        process.exit(0);
    }

    const policy = await loadCargoAgeGatePolicy({
        rootDir,
        configPath: args.configPath,
        minimumAgeDaysOverride: args.minimumAgeDays,
    });
    const now = new Date();
    const cutoffDate = calculateCutoffDate(now, policy.minimumAgeDays);
    const lockfilePath = resolveProjectPath(rootDir, args.lockfilePath);
    const packages = filterPackagesBySelectors(
        collectCratesIoPackages(await readCargoLockPackages(lockfilePath)),
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

    if (violations.length > 0) {
        console.error(
            `Cargo age gate failed: ${violations.length} package version(s) are newer than ${policy.minimumAgeDays} days and are not allowlisted.`,
        );
        for (const violation of violations) {
            console.error(`- ${violation}`);
        }
        process.exit(1);
    }

    console.log(
        `Cargo age gate passed: ${packages.length} crates.io package version(s) checked with a ${policy.minimumAgeDays}d minimum age.`,
    );
    if (allowlisted.length > 0) {
        console.log(`Allowlisted fresh versions: ${allowlisted.length}`);
        for (const value of allowlisted) {
            console.log(`- ${value}`);
        }
    }
} catch (error) {
    if (error instanceof CliUsageError) {
        console.error(error.message);
        printUsage();
        process.exit(2);
    }

    throw error;
}

async function getCachedVersions(versionCache, crateName) {
    let versionsPromise = versionCache.get(crateName);
    if (!versionsPromise) {
        versionsPromise = fetchCrateVersions(crateName);
        versionCache.set(crateName, versionsPromise);
    }
    return versionsPromise;
}

function printUsage() {
    console.log(`Usage: yarn cargo:age-gate [options]

Checks Cargo.lock crates.io packages and fails if any locked version is newer
than the configured minimum age without a policy exception.

Options:
  --config <path>          Policy file. Default: ${DEFAULT_CARGO_AGE_GATE_CONFIG_RELATIVE_PATH}
  --lockfile <path>        Cargo.lock path. Default: ${DEFAULT_CARGO_LOCK_RELATIVE_PATH}
  --manifest-path <path>   Accepted for command symmetry. Default: ${DEFAULT_CARGO_MANIFEST_RELATIVE_PATH}
  --min-age-days <days>    Override configured minimum age.
  --package <name[@ver]>   Limit to one package; repeatable.
  -h, --help               Show this help.
`);
}
