import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    chmod,
    cp,
    mkdtemp,
    mkdir,
    rm,
    readFile,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    compareRuntimeTrees,
    verifyLinuxBundledRuntime,
} from "./verify-linux-bundled-runtime.mjs";
import {
    WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME,
    WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION,
    verifyWalletRecipientIntegritySnapshot,
} from "./wallet-recipient-integrity-snapshot.mjs";

const productName = "ArtGod";

test("accepts an exact regular-file runtime copy", async () => {
    await withRuntimeTrees(async ({ expectedRoot, actualRoot }) => {
        await writeMatchingRuntimeTrees(expectedRoot, actualRoot);
        await compareRuntimeTrees(expectedRoot, actualRoot);
    });
});

test("rejects a post-staging runtime byte mutation", async () => {
    await withRuntimeTrees(async ({ expectedRoot, actualRoot }) => {
        await writeMatchingRuntimeTrees(expectedRoot, actualRoot);
        await writeFile(
            path.join(actualRoot, "node", "node"),
            "packager-mutated",
            "utf8",
        );

        await assert.rejects(
            compareRuntimeTrees(expectedRoot, actualRoot),
            /Bundled runtime integrity mismatch: node\/node/,
        );
    });
});

test("rejects a packaged runtime mode mutation", async () => {
    await withRuntimeTrees(async ({ expectedRoot, actualRoot }) => {
        await writeMatchingRuntimeTrees(expectedRoot, actualRoot);
        await chmod(path.join(actualRoot, "node", "node"), 0o644);

        await assert.rejects(
            compareRuntimeTrees(expectedRoot, actualRoot),
            /Bundled runtime executable mode differs for node\/node/,
        );
    });
});

test("rejects missing and unexpected runtime entries", async () => {
    await withRuntimeTrees(async ({ expectedRoot, actualRoot }) => {
        await writeMatchingRuntimeTrees(expectedRoot, actualRoot);
        await writeFile(
            path.join(actualRoot, "unexpected.mjs"),
            "unexpected",
            "utf8",
        );

        await assert.rejects(
            compareRuntimeTrees(expectedRoot, actualRoot),
            /Unexpected: unexpected\.mjs/,
        );
    });
});

test("rejects symbolic links in either runtime tree", async () => {
    await withRuntimeTrees(async ({ expectedRoot, actualRoot }) => {
        await writeMatchingRuntimeTrees(expectedRoot, actualRoot);
        await symlink(
            path.join(actualRoot, "node", "node"),
            path.join(actualRoot, "node-link"),
        );

        await assert.rejects(
            compareRuntimeTrees(expectedRoot, actualRoot),
            /contains a symbolic link: node-link/,
        );
    });
});

test("extracts both Linux formats and verifies their format-specific runtime paths", async () => {
    await withRuntimeTrees(async ({ temporaryRoot, expectedRoot }) => {
        await writeMatchingRuntimeTree(expectedRoot);
        const integritySnapshotPath = path.join(
            temporaryRoot,
            WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME,
        );
        await writeIntegritySnapshot(expectedRoot, integritySnapshotPath);
        const bundleRoot = path.join(temporaryRoot, "bundle");
        const appImagePath = path.join(
            bundleRoot,
            "appimage",
            "ArtGod.AppImage",
        );
        const debPath = path.join(bundleRoot, "deb", "ArtGod.deb");
        await Promise.all([
            writeFixtureFile(appImagePath, "appimage"),
            writeFixtureFile(debPath, "deb"),
        ]);
        const commands = [];

        await verifyLinuxBundledRuntime({
            bundleRoot,
            stagedRuntimeRoot: expectedRoot,
            integritySnapshotPath,
            productName,
            temporaryRoot,
            async commandRunner(command, args, cwd) {
                commands.push({ command, args, cwd });
                if (command === appImagePath) {
                    assert.deepEqual(args, ["--appimage-extract"]);
                    await cp(
                        expectedRoot,
                        path.join(
                            cwd,
                            "squashfs-root",
                            "usr",
                            "share",
                            productName,
                            "resources",
                            "runtime",
                        ),
                        { recursive: true },
                    );
                    return;
                }
                assert.equal(command, "dpkg-deb");
                assert.deepEqual(args.slice(0, 2), ["--extract", debPath]);
                await cp(
                    expectedRoot,
                    path.join(
                        args[2],
                        "usr",
                        "lib",
                        productName,
                        "resources",
                        "runtime",
                    ),
                    { recursive: true },
                );
            },
        });

        assert.equal(commands.length, 2);
    });
});

test("rejects staging changed after Rust generated its integrity snapshot", async () => {
    await withRuntimeTrees(async ({ temporaryRoot, expectedRoot }) => {
        await writeMatchingRuntimeTree(expectedRoot);
        const integritySnapshotPath = path.join(
            temporaryRoot,
            WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME,
        );
        const snapshot = await writeIntegritySnapshot(
            expectedRoot,
            integritySnapshotPath,
        );
        await writeFile(
            path.join(expectedRoot, "trading", "runtime.mjs"),
            "changed-after-build",
            "utf8",
        );

        await assert.rejects(
            verifyWalletRecipientIntegritySnapshot(snapshot, expectedRoot),
            /differs from the build-time integrity snapshot: trading\/runtime\.mjs/,
        );
    });
});

test("keeps the Rust and JavaScript integrity snapshot contract synchronized", async () => {
    const resourceContract = await readFile(
        new URL(
            "../../src-tauri/src/runtime/resource_contract.rs",
            import.meta.url,
        ),
        "utf8",
    );
    assert.match(
        resourceContract,
        new RegExp(
            `WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME:[\\s\\S]*${escapeRegex(WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME)}`,
        ),
    );
    assert.match(
        resourceContract,
        new RegExp(
            `WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION: u64 = ${WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION};`,
        ),
    );
});

async function withRuntimeTrees(callback) {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-runtime-compare-"),
    );
    const expectedRoot = path.join(temporaryRoot, "expected");
    const actualRoot = path.join(temporaryRoot, "actual");
    await Promise.all([
        mkdir(expectedRoot, { recursive: true }),
        mkdir(actualRoot, { recursive: true }),
    ]);

    try {
        await callback({ temporaryRoot, expectedRoot, actualRoot });
    } finally {
        await rm(temporaryRoot, { force: true, recursive: true });
    }
}

async function writeMatchingRuntimeTrees(expectedRoot, actualRoot) {
    for (const runtimeRoot of [expectedRoot, actualRoot]) {
        await writeMatchingRuntimeTree(runtimeRoot);
    }
}

async function writeMatchingRuntimeTree(runtimeRoot) {
    await mkdir(path.join(runtimeRoot, "node"), { recursive: true });
    await mkdir(path.join(runtimeRoot, "trading"), { recursive: true });
    await mkdir(path.join(runtimeRoot, "empty"), { recursive: true });
    await writeFile(path.join(runtimeRoot, "node", "node"), "node", "utf8");
    await chmod(path.join(runtimeRoot, "node", "node"), 0o755);
    await writeFile(
        path.join(runtimeRoot, "trading", "runtime.mjs"),
        "trading",
        "utf8",
    );
}

async function writeIntegritySnapshot(runtimeRoot, snapshotPath) {
    const protectedRoots = ["node", "trading"];
    const relativePaths = ["node/node", "trading/runtime.mjs"];
    const snapshot = {
        version: WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION,
        protectedRoots,
        files: await Promise.all(
            relativePaths.map(async (relativePath) => ({
                relativePath,
                sha256: createHash("sha256")
                    .update(
                        await readFile(path.join(runtimeRoot, relativePath)),
                    )
                    .digest("hex"),
            })),
        ),
    };
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");
    return {
        protectedRoots: Object.freeze([...snapshot.protectedRoots]),
        files: Object.freeze(
            snapshot.files.map((file) => Object.freeze({ ...file })),
        ),
    };
}

async function writeFixtureFile(filePath, contents) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
