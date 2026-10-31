import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DESKTOP_CARGO_PROJECTS } from "../build/cargo-projects.mjs";

export const DEFAULT_CARGO_AGE_GATE_CONFIG_RELATIVE_PATH = path.join(
    "config",
    "cargo-age-gate.json",
);
export const DEFAULT_CARGO_LOCK_RELATIVE_PATH =
    DESKTOP_CARGO_PROJECTS.Desktop.lockfilePath;
export const DEFAULT_CARGO_MANIFEST_RELATIVE_PATH =
    DESKTOP_CARGO_PROJECTS.Desktop.manifestPath;
export {
    DEFAULT_MINIMUM_AGE_DAYS,
    calculateCutoffDate,
} from "./dependency-age-policy.mjs";
export const CRATES_IO_REGISTRY_SOURCE =
    "registry+https://github.com/rust-lang/crates.io-index";
export const CRATES_IO_API_BASE_URL = "https://crates.io/api/v1/crates";
export const CRATES_IO_SPARSE_INDEX_BASE_URL = "https://index.crates.io";
export const CARGO_UPDATE_COMMAND = "cargo";
export const CARGO_AGE_GATE_USER_AGENT =
    "artgod-cargo-age-gate/1.0 (https://github.com/d347h-eth/artgod)";
// The sparse index has no API rate cap. Bound parallel reads; API fallbacks
// share a separate sequential queue with a one-second interval after responses.
export const DEFAULT_CRATES_IO_METADATA_CONCURRENCY = 8;
const CRATES_IO_MINIMUM_REQUEST_INTERVAL_MS = 1000;
const CRATES_IO_METADATA_TIMEOUT_MS = 30_000;

const PACKAGE_HEADER = "[[package]]";
const PACKAGE_NAME_FIELD = "name";
const PACKAGE_VERSION_FIELD = "version";
const PACKAGE_SOURCE_FIELD = "source";
const PACKAGE_CHECKSUM_FIELD = "checksum";
const CONFIG_MINIMUM_AGE_DAYS_FIELD = "minimumAgeDays";
const CONFIG_FRESH_VERSION_EXCEPTIONS_FIELD = "freshVersionExceptions";
const CONFIG_EXCEPTION_NAME_FIELD = "name";
const CONFIG_EXCEPTION_VERSION_FIELD = "version";
const CONFIG_EXCEPTION_REASON_FIELD = "reason";
const CONFIG_EXCEPTION_EXPIRES_ON_FIELD = "expiresOn";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export class CliUsageError extends Error {}

export function resolveProjectPath(rootDir, value) {
    return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

export function formatDateOnly(date) {
    return date.toISOString().slice(0, 10);
}

export function packageKey(packageEntry) {
    return `${packageEntry.name}@${packageEntry.version}`;
}

export function versionExceptionKey(name, version) {
    return `${name}@${version}`;
}

export function parsePackageSelector(value) {
    const separatorIndex = value.lastIndexOf("@");
    if (separatorIndex <= 0) {
        return { name: value, version: undefined };
    }

    return {
        name: value.slice(0, separatorIndex),
        version: value.slice(separatorIndex + 1),
    };
}

export function matchesPackageSelector(packageEntry, selector) {
    return (
        packageEntry.name === selector.name &&
        (!selector.version || packageEntry.version === selector.version)
    );
}

export async function loadCargoAgeGatePolicy({
    rootDir,
    configPath,
    minimumAgeDaysOverride,
}) {
    const resolvedConfigPath = resolveProjectPath(rootDir, configPath);
    const config = JSON.parse(await readFile(resolvedConfigPath, "utf8"));
    const minimumAgeDays =
        minimumAgeDaysOverride ?? config[CONFIG_MINIMUM_AGE_DAYS_FIELD];

    if (!Number.isInteger(minimumAgeDays) || minimumAgeDays < 0) {
        throw new Error(
            `${CONFIG_MINIMUM_AGE_DAYS_FIELD} must be a non-negative integer`,
        );
    }

    const exceptions = config[CONFIG_FRESH_VERSION_EXCEPTIONS_FIELD] ?? [];
    if (!Array.isArray(exceptions)) {
        throw new Error(
            `${CONFIG_FRESH_VERSION_EXCEPTIONS_FIELD} must be an array`,
        );
    }

    const freshVersionExceptions = new Map();
    for (const exception of exceptions) {
        const name = exception?.[CONFIG_EXCEPTION_NAME_FIELD];
        const version = exception?.[CONFIG_EXCEPTION_VERSION_FIELD];
        const reason = exception?.[CONFIG_EXCEPTION_REASON_FIELD];
        const expiresOn = exception?.[CONFIG_EXCEPTION_EXPIRES_ON_FIELD];

        if (!name || !version || !reason) {
            throw new Error(
                `${CONFIG_FRESH_VERSION_EXCEPTIONS_FIELD} entries require name, version, and reason`,
            );
        }

        if (expiresOn && Number.isNaN(Date.parse(`${expiresOn}T00:00:00Z`))) {
            throw new Error(
                `${CONFIG_EXCEPTION_EXPIRES_ON_FIELD} must use YYYY-MM-DD when present`,
            );
        }

        freshVersionExceptions.set(versionExceptionKey(name, version), {
            name,
            version,
            reason,
            expiresOn,
        });
    }

    return {
        configPath: resolvedConfigPath,
        minimumAgeDays,
        freshVersionExceptions,
    };
}

export async function readCargoLockPackages(lockfilePath) {
    const source = await readFile(lockfilePath, "utf8");
    return parseCargoLockPackages(source);
}

export function parseCargoLockPackages(source) {
    const packages = [];
    let currentPackage;

    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === PACKAGE_HEADER) {
            if (currentPackage) {
                packages.push(currentPackage);
            }
            currentPackage = {};
            continue;
        }

        if (!currentPackage) {
            continue;
        }

        const field = parseTomlStringField(line);
        if (!field) {
            continue;
        }

        if (
            field.key === PACKAGE_NAME_FIELD ||
            field.key === PACKAGE_VERSION_FIELD ||
            field.key === PACKAGE_SOURCE_FIELD ||
            field.key === PACKAGE_CHECKSUM_FIELD
        ) {
            currentPackage[field.key] = field.value;
        }
    }

    if (currentPackage) {
        packages.push(currentPackage);
    }

    return packages.filter(
        (packageEntry) => packageEntry.name && packageEntry.version,
    );
}

export function collectCratesIoPackages(packages) {
    const uniquePackages = new Map();

    for (const packageEntry of packages) {
        if (packageEntry.source !== CRATES_IO_REGISTRY_SOURCE) {
            continue;
        }
        uniquePackages.set(packageKey(packageEntry), packageEntry);
    }

    return [...uniquePackages.values()].sort(comparePackageEntries);
}

// Both admission and aged updates use this reader. When requiredVersions is
// supplied, return only those versions and ignore dates of unrelated releases.
export function createCratesIoMetadataReader({
    fetchImplementation = fetch,
    delay = (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
    let apiQueue = Promise.resolve();

    async function request(url) {
        const response = await fetchImplementation(url, {
            headers: {
                accept: "application/json",
                "user-agent": CARGO_AGE_GATE_USER_AGENT,
            },
            signal: AbortSignal.timeout(CRATES_IO_METADATA_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(
                `crates.io metadata request failed for ${url}: ${response.status} ${response.statusText}`,
            );
        }
        return response;
    }

    function readApiVersions(crateName) {
        const pending = apiQueue.then(async () => {
            try {
                const response = await request(
                    `${CRATES_IO_API_BASE_URL}/${encodeURIComponent(crateName)}/versions`,
                );
                const payload = await response.json();
                if (
                    !Array.isArray(payload.versions) ||
                    !payload.versions.length
                ) {
                    throw new Error(
                        `crates.io metadata for ${crateName} is missing versions`,
                    );
                }
                return payload.versions.map((entry) =>
                    versionMetadata({
                        number: entry.num,
                        publishedAt: entry.created_at,
                        checksum: entry.checksum,
                        yanked: entry.yanked,
                        crateName,
                    }),
                );
            } finally {
                // A single shared queue enforces the API limit even when many
                // sparse-index workers need fallback at the same time.
                await delay(CRATES_IO_MINIMUM_REQUEST_INTERVAL_MS);
            }
        });
        apiQueue = pending.catch(() => {});
        return pending;
    }

    return async (crateName, { requiredVersions } = {}) => {
        const wanted = requiredVersions ? new Set(requiredVersions) : null;
        const response = await request(cratesIoSparseIndexUrl(crateName));
        if (!response.body)
            throw new Error(`Empty sparse index for ${crateName}`);
        const versions = [];
        const seen = new Set();
        let rows = 0;
        let needsFallback = false;
        for await (const entry of readIndexEntries(response.body)) {
            rows += 1;
            if (
                entry.name?.toLowerCase() !== crateName.toLowerCase() ||
                typeof entry.vers !== "string" ||
                !entry.vers
            ) {
                throw new Error(
                    `Invalid sparse-index identity for ${crateName}`,
                );
            }
            if (seen.has(entry.vers))
                throw new Error(
                    `Duplicate sparse-index version for ${crateName}@${entry.vers}`,
                );
            seen.add(entry.vers);
            if (wanted && !wanted.has(entry.vers)) continue;
            if (entry.pubtime == null) {
                needsFallback = true;
                continue;
            }
            versions.push(
                versionMetadata({
                    number: entry.vers,
                    publishedAt: entry.pubtime,
                    checksum: entry.cksum,
                    yanked: entry.yanked,
                    crateName,
                }),
            );
        }
        if (!rows) throw new Error(`Empty sparse index for ${crateName}`);
        // A stale index can omit a just-published locked version. Ask the same
        // registry's API; never infer an age or silently admit missing metadata.
        if (needsFallback || (wanted && versions.length !== wanted.size)) {
            const fallback = await readApiVersions(crateName);
            return wanted
                ? fallback.filter((entry) => wanted.has(entry.number))
                : fallback;
        }
        return versions;
    };
}

async function* readIndexEntries(body) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    for await (const chunk of body) {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (line.trim()) yield JSON.parse(line);
        }
    }
    pending += decoder.decode();
    if (pending.trim()) yield JSON.parse(pending);
}

export const fetchCrateVersions = createCratesIoMetadataReader();

export function cratesIoSparseIndexUrl(crateName) {
    if (!/^[A-Za-z0-9_-]+$/.test(crateName)) {
        throw new Error(`Invalid crates.io package name: ${crateName}`);
    }
    const name = crateName.toLowerCase();
    const prefix =
        name.length === 1
            ? "1"
            : name.length === 2
              ? "2"
              : name.length === 3
                ? `3/${name[0]}`
                : `${name.slice(0, 2)}/${name.slice(2, 4)}`;
    return `${CRATES_IO_SPARSE_INDEX_BASE_URL}/${prefix}/${name}`;
}

function versionMetadata({ number, publishedAt, checksum, yanked, crateName }) {
    const createdAt = new Date(publishedAt);
    if (
        typeof number !== "string" ||
        !number ||
        typeof publishedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(
            publishedAt,
        ) ||
        Number.isNaN(createdAt.getTime()) ||
        createdAt.toISOString().slice(0, 19) !== publishedAt.slice(0, 19) ||
        typeof checksum !== "string" ||
        !/^[a-f0-9]{64}$/i.test(checksum)
    ) {
        throw new Error(`Invalid version metadata for ${crateName}@${number}`);
    }
    return { number, createdAt, checksum, yanked: Boolean(yanked) };
}

export function findVersionMetadata(versions, packageEntry) {
    return versions.find((version) => version.number === packageEntry.version);
}

export function isFreshVersionAllowed({
    freshVersionExceptions,
    now,
    packageEntry,
}) {
    const exception = freshVersionExceptions.get(packageKey(packageEntry));
    if (!exception) {
        return false;
    }

    if (!exception.expiresOn) {
        return true;
    }

    const expiresAt = new Date(`${exception.expiresOn}T23:59:59Z`);
    return now <= expiresAt;
}

export function getFreshVersionExceptionReason({
    freshVersionExceptions,
    packageEntry,
}) {
    return freshVersionExceptions.get(packageKey(packageEntry))?.reason;
}

export function selectNewestEligibleCompatibleVersion({
    versions,
    currentVersion,
    cutoffDate,
}) {
    const currentSemver = parseSemver(currentVersion);
    const currentIsPrerelease = currentSemver.prerelease.length > 0;

    return versions
        .filter((version) => !version.yanked)
        .filter((version) => version.createdAt <= cutoffDate)
        .filter((version) => {
            const candidateSemver = parseSemver(version.number);
            if (!currentIsPrerelease && candidateSemver.prerelease.length > 0) {
                return false;
            }
            return isCargoCaretCompatible(currentSemver, candidateSemver);
        })
        .sort((left, right) => compareSemver(right.number, left.number))[0];
}

export function describeVersionAge(versionMetadata, now) {
    const ageDays = Math.floor(
        (now.getTime() - versionMetadata.createdAt.getTime()) /
            MILLISECONDS_PER_DAY,
    );
    return `${ageDays}d old, published ${formatDateOnly(versionMetadata.createdAt)}`;
}

export function runCargoUpdate({ manifestPath, packageEntry, targetVersion }) {
    const result = spawnSync(
        CARGO_UPDATE_COMMAND,
        [
            "update",
            "--manifest-path",
            manifestPath,
            "-p",
            packageKey(packageEntry),
            "--precise",
            targetVersion,
        ],
        {
            stdio: "inherit",
        },
    );

    if (result.error) {
        throw result.error;
    }

    return result.status ?? 1;
}

export function parseCommonArgs(
    argv,
    {
        allowDryRun = false,
        defaultProject = DESKTOP_CARGO_PROJECTS.Desktop,
    } = {},
) {
    const args = {
        configPath: DEFAULT_CARGO_AGE_GATE_CONFIG_RELATIVE_PATH,
        lockfilePath: undefined,
        manifestPath: undefined,
        minimumAgeDays: undefined,
        packageSelectors: [],
        dryRun: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        switch (value) {
            case "--config":
                args.configPath = requireNextArg(argv, index, value);
                index += 1;
                break;
            case "--lockfile":
                args.lockfilePath = requireNextArg(argv, index, value);
                index += 1;
                break;
            case "--manifest-path":
                args.manifestPath = requireNextArg(argv, index, value);
                index += 1;
                break;
            case "--min-age-days": {
                const rawMinimumAgeDays = requireNextArg(argv, index, value);
                args.minimumAgeDays = Number(rawMinimumAgeDays);
                if (
                    !Number.isInteger(args.minimumAgeDays) ||
                    args.minimumAgeDays < 0
                ) {
                    throw new CliUsageError(
                        "--min-age-days requires a non-negative integer",
                    );
                }
                index += 1;
                break;
            }
            case "--package":
                args.packageSelectors.push(
                    parsePackageSelector(requireNextArg(argv, index, value)),
                );
                index += 1;
                break;
            case "--dry-run":
                if (!allowDryRun) {
                    throw new CliUsageError(
                        "--dry-run is not supported by this command",
                    );
                }
                args.dryRun = true;
                break;
            case "-h":
            case "--help":
                args.help = true;
                break;
            default:
                throw new CliUsageError(`Unknown argument: ${value}`);
        }
    }

    // An explicit project selection must inspect the same lockfile that Cargo uses.
    if (args.manifestPath && !args.lockfilePath) {
        args.lockfilePath = path.join(
            path.dirname(args.manifestPath),
            "Cargo.lock",
        );
    } else if (args.lockfilePath && !args.manifestPath) {
        args.manifestPath = path.join(
            path.dirname(args.lockfilePath),
            "Cargo.toml",
        );
    } else if (!args.manifestPath && defaultProject) {
        args.manifestPath = defaultProject.manifestPath;
        args.lockfilePath = defaultProject.lockfilePath;
    }
    if (
        args.manifestPath &&
        args.lockfilePath &&
        path.resolve(path.dirname(args.manifestPath)) !==
            path.resolve(path.dirname(args.lockfilePath))
    ) {
        throw new CliUsageError(
            "Manifest and lockfile must select the same independent Cargo root.",
        );
    }
    return args;
}

export function filterPackagesBySelectors(packages, selectors) {
    if (selectors.length === 0) {
        return packages;
    }

    return packages.filter((packageEntry) =>
        selectors.some((selector) =>
            matchesPackageSelector(packageEntry, selector),
        ),
    );
}

export async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let failed = false;
    let failure;

    async function worker() {
        while (!failed && nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            try {
                results[currentIndex] = await mapper(
                    items[currentIndex],
                    currentIndex,
                );
            } catch (error) {
                if (!failed) failure = error;
                failed = true;
            }
        }
    }

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker(),
    );
    await Promise.all(workers);
    if (failed) throw failure;

    return results;
}

function parseTomlStringField(line) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"((?:\\.|[^"])*)"$/);
    if (!match) {
        return undefined;
    }

    return {
        key: match[1],
        value: JSON.parse(`"${match[2]}"`),
    };
}

function requireNextArg(argv, index, flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
        throw new CliUsageError(`${flag} requires a value`);
    }
    return value;
}

function comparePackageEntries(left, right) {
    const nameComparison = left.name.localeCompare(right.name);
    if (nameComparison !== 0) {
        return nameComparison;
    }
    return compareSemver(left.version, right.version);
}

function parseSemver(version) {
    const withoutBuildMetadata = version.split("+")[0];
    const [core, prereleaseSource = ""] = withoutBuildMetadata.split("-", 2);
    const [major, minor, patch] = core.split(".").map((part) => Number(part));

    if (
        !Number.isInteger(major) ||
        !Number.isInteger(minor) ||
        !Number.isInteger(patch)
    ) {
        throw new Error(`Unsupported Cargo package version: ${version}`);
    }

    return {
        major,
        minor,
        patch,
        prerelease: prereleaseSource ? prereleaseSource.split(".") : [],
    };
}

function isCargoCaretCompatible(current, candidate) {
    if (current.major > 0) {
        return candidate.major === current.major;
    }

    if (current.minor > 0) {
        return candidate.major === 0 && candidate.minor === current.minor;
    }

    return (
        candidate.major === 0 &&
        candidate.minor === 0 &&
        candidate.patch === current.patch
    );
}

// Shared by dependency admission and the enabled-crypto regression gate.
export function compareSemver(leftVersion, rightVersion) {
    const left = parseSemver(leftVersion);
    const right = parseSemver(rightVersion);

    for (const key of ["major", "minor", "patch"]) {
        if (left[key] !== right[key]) {
            return left[key] - right[key];
        }
    }

    if (left.prerelease.length === 0 && right.prerelease.length > 0) {
        return 1;
    }

    if (left.prerelease.length > 0 && right.prerelease.length === 0) {
        return -1;
    }

    const segmentCount = Math.max(
        left.prerelease.length,
        right.prerelease.length,
    );
    for (let index = 0; index < segmentCount; index += 1) {
        const leftSegment = left.prerelease[index];
        const rightSegment = right.prerelease[index];
        if (leftSegment === undefined) {
            return -1;
        }
        if (rightSegment === undefined) {
            return 1;
        }

        const comparison = comparePrereleaseSegment(leftSegment, rightSegment);
        if (comparison !== 0) {
            return comparison;
        }
    }

    return 0;
}

function comparePrereleaseSegment(left, right) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    const leftIsNumber = String(leftNumber) === left;
    const rightIsNumber = String(rightNumber) === right;

    if (leftIsNumber && rightIsNumber) {
        return leftNumber - rightNumber;
    }
    if (leftIsNumber) {
        return -1;
    }
    if (rightIsNumber) {
        return 1;
    }
    return left.localeCompare(right);
}
