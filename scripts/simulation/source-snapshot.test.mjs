import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { snapshotSource, assertSameSource } from "./source-snapshot.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(path.join(root, "tmp/source-provenance"), { recursive: true });

test("source attribution includes untracked bytes, deletions and symlink targets", async () => {
    const directory = await mkdtemp(
        path.join(root, "tmp/source-provenance/test-"),
    );
    await mkdir(path.join(directory, "shared"));
    await writeFile(path.join(directory, "shared/tracked.ts"), "initial");
    await writeFile(path.join(directory, "shared/new.ts"), "untracked");
    await symlink("tracked.ts", path.join(directory, "shared/alias.ts"));
    const execute = async (_file, args) => ({
        code: 0,
        stdout:
            args[0] === "rev-parse"
                ? `${"a".repeat(40)}\n`
                : "shared/tracked.ts\0shared/deleted.ts\0shared/new.ts\0shared/alias.ts\0shared/tracked.ts\0",
    });
    const before = await snapshotSource(directory, { execute });
    assert.equal(before.files.length, 3);
    assert.equal(
        before.files.find((entry) => entry.path === "shared/alias.ts").symlink,
        "tracked.ts",
    );
    assertSameSource(before, await snapshotSource(directory, { execute }));
    await writeFile(
        path.join(directory, "shared/new.ts"),
        "changed untracked source",
    );
    assert.throws(
        () => assertSameSource(before, {}),
        /changed during compilation/,
    );
    assert.throws(
        () => assertSameSource(before, undefined),
        /changed during compilation/,
    );
    const after = await snapshotSource(directory, { execute });
    assert.throws(
        () => assertSameSource(before, after),
        /changed during compilation/,
    );
});

test("incomplete source listing fails rather than omitting provenance", async () => {
    await assert.rejects(
        snapshotSource(root, {
            execute: async () => ({ code: 1, stdout: "" }),
        }),
        /Cannot capture/,
    );
});
