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
    describeVersionAge,
    fetchCrateVersions,
    filterPackagesBySelectors,
    findVersionMetadata,
    getFreshVersionExceptionReason,
    isFreshVersionAllowed,
    loadCargoAgeGatePolicy,
    packageKey,
    parseCommonArgs,
    readCargoLockPackages,
    resolveProjectPath,
    runCargoUpdate,
    selectNewestEligibleCompatibleVersion,
} from "./cargo-age-gate-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

try {
    const args = parseCommonArgs(process.argv.slice(2), { allowDryRun: true });
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
    const manifestPath = resolveProjectPath(rootDir, args.manifestPath);
    const lockfilePath = resolveProjectPath(rootDir, args.lockfilePath);
    const packages = filterPackagesBySelectors(
        collectCratesIoPackages(await readCargoLockPackages(lockfilePath)),
        args.packageSelectors,
    );
    const versionCache = new Map();
    const updated = [];
    const unchanged = [];
    const skipped = [];
    const blocked = [];
    let lockedPackageKeys = new Set(packages.map(packageKey));

    for (const packageEntry of packages) {
        if (!lockedPackageKeys.has(packageKey(packageEntry))) {
            skipped.push(
                `${packageKey(packageEntry)}: already changed by an earlier cargo update`,
            );
            continue;
        }

        const versions = await getCachedVersions(
            versionCache,
            packageEntry.name,
        );
        const currentMetadata = findVersionMetadata(versions, packageEntry);
        if (!currentMetadata) {
            blocked.push(
                `${packageKey(packageEntry)}: current version is missing from crates.io metadata`,
            );
            continue;
        }

        if (
            currentMetadata.createdAt > cutoffDate &&
            isFreshVersionAllowed({
                freshVersionExceptions: policy.freshVersionExceptions,
                now,
                packageEntry,
            })
        ) {
            skipped.push(
                `${packageKey(packageEntry)}: allowlisted fresh version (${getFreshVersionExceptionReason(
                    {
                        freshVersionExceptions: policy.freshVersionExceptions,
                        packageEntry,
                    },
                )})`,
            );
            continue;
        }

        const targetMetadata = selectNewestEligibleCompatibleVersion({
            versions,
            currentVersion: packageEntry.version,
            cutoffDate,
        });
        if (!targetMetadata) {
            blocked.push(
                `${packageKey(packageEntry)}: no non-yanked compatible version at least ${policy.minimumAgeDays}d old`,
            );
            continue;
        }

        if (targetMetadata.number === packageEntry.version) {
            unchanged.push(
                `${packageKey(packageEntry)} (${describeVersionAge(targetMetadata, now)})`,
            );
            continue;
        }

        const updateLabel = `${packageKey(packageEntry)} -> ${targetMetadata.number} (${describeVersionAge(
            targetMetadata,
            now,
        )})`;
        if (args.dryRun) {
            updated.push(`[dry-run] ${updateLabel}`);
            continue;
        }

        const status = runCargoUpdate({
            manifestPath,
            packageEntry,
            targetVersion: targetMetadata.number,
        });
        lockedPackageKeys = await readLockedPackageKeys(lockfilePath);
        if (status === 0) {
            updated.push(updateLabel);
        } else if (!lockedPackageKeys.has(packageKey(packageEntry))) {
            skipped.push(
                `${packageKey(packageEntry)}: already changed by an earlier cargo update`,
            );
        } else {
            blocked.push(
                `${updateLabel}: cargo update exited with status ${status}`,
            );
        }
    }

    printSummary({ updated, unchanged, skipped, blocked });
    if (blocked.length > 0) {
        process.exitCode = 1;
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
    let versions = versionCache.get(crateName);
    if (!versions) {
        versions = await fetchCrateVersions(crateName);
        versionCache.set(crateName, versions);
    }
    return versions;
}

async function readLockedPackageKeys(lockfilePath) {
    return new Set(
        collectCratesIoPackages(await readCargoLockPackages(lockfilePath)).map(
            packageKey,
        ),
    );
}

function printSummary({ updated, unchanged, skipped, blocked }) {
    console.log(`Cargo aged update completed.`);
    console.log(`Updated: ${updated.length}`);
    console.log(`Already eligible: ${unchanged.length}`);
    console.log(`Skipped by fresh-version exception: ${skipped.length}`);
    console.log(`Blocked: ${blocked.length}`);

    printList("Updates", updated);
    printList("Skipped", skipped);
    printList("Blocked", blocked);
}

function printList(label, values) {
    if (values.length === 0) {
        return;
    }

    console.log(`\n${label}:`);
    for (const value of values) {
        console.log(`- ${value}`);
    }
}

function printUsage() {
    console.log(`Usage: yarn cargo:update-aged [options]

Updates Cargo.lock crates.io packages toward the newest non-yanked versions that
are at least the configured minimum age and are Cargo-caret-compatible with the
currently locked version.

Options:
  --config <path>          Policy file. Default: ${DEFAULT_CARGO_AGE_GATE_CONFIG_RELATIVE_PATH}
  --lockfile <path>        Cargo.lock path. Default: ${DEFAULT_CARGO_LOCK_RELATIVE_PATH}
  --manifest-path <path>   Cargo.toml path. Default: ${DEFAULT_CARGO_MANIFEST_RELATIVE_PATH}
  --min-age-days <days>    Override configured minimum age.
  --package <name[@ver]>   Limit to one package; repeatable.
  --dry-run                Print candidate updates without running cargo update.
  -h, --help               Show this help.
`);
}
