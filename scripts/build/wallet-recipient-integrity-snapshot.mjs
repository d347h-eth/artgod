import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Names the build-time snapshot shared by Rust and release verification.
export const WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME =
    ".artgod-wallet-recipient-integrity.json";
// Versions the cross-language wallet-recipient integrity contract.
export const WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXECUTABLE_MODE_MASK = 0o111;

// Reads and validates one immutable snapshot with its source path in failures.
export async function readWalletRecipientIntegritySnapshot(snapshotPath) {
    try {
        return parseWalletRecipientIntegritySnapshot(
            JSON.parse(await readFile(snapshotPath, "utf8")),
        );
    } catch (error) {
        throw new Error(
            `Unable to read wallet-recipient integrity snapshot ${snapshotPath}: ${String(error)}`,
            { cause: error },
        );
    }
}

// Verifies one runtime tree against the immutable wallet-recipient snapshot from build.rs.
export async function verifyWalletRecipientIntegritySnapshot(
    snapshot,
    runtimeRoot,
) {
    const expectedFiles = new Map(
        snapshot.files.map((file) => [file.relativePath, file.sha256]),
    );
    const actualFiles = new Map();

    for (const protectedRoot of snapshot.protectedRoots) {
        const protectedEntries = await collectRuntimeEntries(
            path.join(runtimeRoot, protectedRoot),
        );
        for (const [relativePath, entry] of protectedEntries) {
            if (entry.type !== "file") continue;
            actualFiles.set(
                normalizePath(path.join(protectedRoot, relativePath)),
                entry.sha256,
            );
        }
    }

    const expectedPaths = [...expectedFiles.keys()].sort((left, right) =>
        left.localeCompare(right),
    );
    const actualPaths = [...actualFiles.keys()].sort((left, right) =>
        left.localeCompare(right),
    );
    if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
        throw new Error(
            "Wallet-recipient runtime file set differs from the build-time integrity snapshot.",
        );
    }
    for (const relativePath of expectedPaths) {
        if (expectedFiles.get(relativePath) !== actualFiles.get(relativePath)) {
            throw new Error(
                `Wallet-recipient runtime differs from the build-time integrity snapshot: ${relativePath}`,
            );
        }
    }
}

// Parses the cross-language snapshot emitted alongside the final Rust executable.
export function parseWalletRecipientIntegritySnapshot(snapshot) {
    if (
        !snapshot ||
        typeof snapshot !== "object" ||
        Array.isArray(snapshot) ||
        snapshot.version !== WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION ||
        !Array.isArray(snapshot.protectedRoots) ||
        snapshot.protectedRoots.length === 0 ||
        !Array.isArray(snapshot.files) ||
        snapshot.files.length === 0
    ) {
        throw new Error("Invalid wallet-recipient integrity snapshot.");
    }

    const protectedRoots = snapshot.protectedRoots.map((protectedRoot) =>
        validatePortableRelativePath(protectedRoot, "protected root"),
    );
    if (new Set(protectedRoots).size !== protectedRoots.length) {
        throw new Error(
            "Wallet-recipient integrity snapshot contains duplicate protected roots.",
        );
    }
    for (const [index, left] of protectedRoots.entries()) {
        for (const right of protectedRoots.slice(index + 1)) {
            if (left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
                throw new Error(
                    "Wallet-recipient integrity snapshot contains overlapping protected roots.",
                );
            }
        }
    }

    const seenPaths = new Set();
    const files = snapshot.files.map((file) => {
        if (!file || typeof file !== "object" || Array.isArray(file)) {
            throw new Error(
                "Wallet-recipient integrity snapshot contains an invalid file.",
            );
        }
        const relativePath = validatePortableRelativePath(
            file.relativePath,
            "file path",
        );
        if (
            !protectedRoots.some(
                (protectedRoot) =>
                    relativePath === protectedRoot ||
                    relativePath.startsWith(`${protectedRoot}/`),
            )
        ) {
            throw new Error(
                `Wallet-recipient integrity snapshot file is outside protected roots: ${relativePath}`,
            );
        }
        if (seenPaths.has(relativePath)) {
            throw new Error(
                `Wallet-recipient integrity snapshot contains a duplicate file: ${relativePath}`,
            );
        }
        if (
            typeof file.sha256 !== "string" ||
            !SHA256_PATTERN.test(file.sha256)
        ) {
            throw new Error(
                `Wallet-recipient integrity snapshot has an invalid SHA-256: ${relativePath}`,
            );
        }
        seenPaths.add(relativePath);
        return Object.freeze({ relativePath, sha256: file.sha256 });
    });

    return Object.freeze({
        protectedRoots: Object.freeze(protectedRoots),
        files: Object.freeze(files),
    });
}

// Collects the runtime entry metadata used by release tree comparisons.
export async function collectRuntimeEntries(runtimeRoot) {
    const rootStat = await lstat(runtimeRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`Runtime root is not a real directory: ${runtimeRoot}`);
    }

    const entries = new Map();
    await collectDirectory(runtimeRoot, runtimeRoot, entries);
    if (entries.size === 0) {
        throw new Error(`Runtime tree is empty: ${runtimeRoot}`);
    }
    return entries;
}

async function collectDirectory(runtimeRoot, directoryPath, entries) {
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
        const childPath = path.join(directoryPath, child.name);
        const relativePath = normalizePath(
            path.relative(runtimeRoot, childPath),
        );
        const childStat = await lstat(childPath);
        if (childStat.isSymbolicLink()) {
            throw new Error(
                `Runtime tree contains a symbolic link: ${relativePath}`,
            );
        }
        if (childStat.isDirectory()) {
            entries.set(relativePath, {
                type: "directory",
                executableMode: childStat.mode & EXECUTABLE_MODE_MASK,
            });
            await collectDirectory(runtimeRoot, childPath, entries);
            continue;
        }
        if (childStat.isFile()) {
            entries.set(relativePath, {
                type: "file",
                executableMode: childStat.mode & EXECUTABLE_MODE_MASK,
                sha256: await hashFile(childPath),
            });
            continue;
        }
        throw new Error(
            `Runtime tree contains an unsupported file type: ${relativePath}`,
        );
    }
}

async function hashFile(filePath) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}

function normalizePath(filePath) {
    return filePath.split(path.sep).join("/");
}

function validatePortableRelativePath(value, description) {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\\") ||
        path.posix.isAbsolute(value) ||
        value
            .split("/")
            .some(
                (component) =>
                    !component || component === "." || component === "..",
            )
    ) {
        throw new Error(
            `Wallet-recipient integrity snapshot has an invalid ${description}.`,
        );
    }
    return value;
}
