import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    symlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { materializePinnedInput } from "./pinned-build-inputs.mjs";

const scratchRoot = fileURLToPath(new URL("../../tmp/", import.meta.url));
const content = Buffer.from("reviewed bytes");
const input = {
    fileName: "input.bin",
    url: "https://example.invalid/input.bin",
    sizeBytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
};

async function fixture() {
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(path.join(scratchRoot, "pinned-input-test-"));
    const temporaryDirectory = path.join(root, "download");
    await mkdir(temporaryDirectory);
    return {
        root,
        temporaryDirectory,
        destinationPath: path.join(root, input.fileName),
        input,
    };
}

test("valid cached bytes work offline and are rehashed before reuse", async () => {
    const options = await fixture();
    await writeFile(options.destinationPath, content);
    const offline = async () => {
        throw new Error("network unavailable");
    };
    assert.equal(
        await materializePinnedInput({
            ...options,
            verifyProvenance: offline,
            fetchImplementation: offline,
        }),
        options.destinationPath,
    );
    await writeFile(options.destinationPath, Buffer.from("unreviewed xyz"));
    await assert.rejects(
        materializePinnedInput({
            ...options,
            verifyProvenance: offline,
            fetchImplementation: offline,
        }),
        /network unavailable/,
    );
});

test("oversized, truncated and same-size modified downloads cannot replace a cache entry", async () => {
    for (const downloaded of [
        Buffer.concat([content, content]),
        content.subarray(1),
        Buffer.alloc(content.length),
    ]) {
        const options = await fixture();
        await writeFile(options.destinationPath, "old invalid cache");
        await assert.rejects(
            materializePinnedInput({
                ...options,
                verifyProvenance: async () => {},
                fetchImplementation: async () => new Response(downloaded),
            }),
            /size mismatch|SHA-256 mismatch/,
        );
        assert.equal(
            await readFile(options.destinationPath, "utf8"),
            "old invalid cache",
        );
        assert.deepEqual(await readdir(options.temporaryDirectory), []);
    }
});

test("failed provenance prevents the binary request", async () => {
    const options = await fixture();
    await assert.rejects(
        materializePinnedInput({
            ...options,
            verifyProvenance: async () => {
                throw new Error("publication changed");
            },
            fetchImplementation: async () => {
                assert.fail("binary must not be fetched");
            },
        }),
        /publication changed/,
    );
    assert.deepEqual(await readdir(options.temporaryDirectory), []);
});

test("a cache symlink is replaced without following or changing its target", async () => {
    const options = await fixture();
    const otherPath = path.join(options.root, "other.bin");
    await writeFile(otherPath, content);
    await symlink(otherPath, options.destinationPath);
    let requests = 0;
    await materializePinnedInput({
        ...options,
        verifyProvenance: async () => {},
        fetchImplementation: async () => {
            requests++;
            return new Response(content);
        },
    });
    assert.equal(requests, 1);
    await writeFile(otherPath, "changed outside cache");
    assert.deepEqual(await readFile(options.destinationPath), content);
});
