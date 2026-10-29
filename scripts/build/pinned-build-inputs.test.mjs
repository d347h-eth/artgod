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
import {
    assertPinnedInputAge,
    materializePinnedInput,
    verifyGithubReleaseInputProvenance,
} from "./pinned-build-inputs.mjs";
import { ENV_GITHUB_TOKEN, GITHUB_METADATA_MEDIA_TYPE } from "./github-api.mjs";

const scratchRoot = fileURLToPath(new URL("../../tmp/", import.meta.url));
const content = Buffer.from("reviewed bytes");
const input = {
    fileName: "input.bin",
    url: "https://example.invalid/input.bin",
    sizeBytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
};

test("a fresh security exception admits only its exact input until expiry", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    const fresh = {
        ...input,
        name: "node",
        version: "24.22.1",
        publishedAt: "2026-10-21T00:00:00Z",
    };
    const exceptions = [
        {
            name: fresh.name,
            version: fresh.version,
            reason: "October TLS and Brotli security fixes",
            expiresOn: "2026-11-30",
        },
    ];
    assert.throws(() => assertPinnedInputAge(fresh, 30, now), /age gate/);
    assert.doesNotThrow(() => assertPinnedInputAge(fresh, 30, now, exceptions));
    for (const changed of [{ name: "nats" }, { version: "24.22.2" }]) {
        assert.throws(
            () =>
                assertPinnedInputAge(
                    { ...fresh, ...changed },
                    30,
                    now,
                    exceptions,
                ),
            /age gate/,
        );
    }
    assert.throws(
        () =>
            assertPinnedInputAge(fresh, 30, now, [
                { ...exceptions[0], expiresOn: "2026-10-28" },
            ]),
        /age gate/,
    );
    assert.throws(
        () =>
            assertPinnedInputAge(
                { ...fresh, publishedAt: "invalid" },
                30,
                now,
                exceptions,
            ),
        /publication timestamp/,
    );
    assert.throws(
        () => assertPinnedInputAge(fresh, 0, now, exceptions),
        /minimum age/,
    );
    for (const changed of [
        { reason: "" },
        { version: "24.*" },
        { expiresOn: "invalid" },
    ]) {
        assert.throws(
            () =>
                assertPinnedInputAge(fresh, 30, now, [
                    { ...exceptions[0], ...changed },
                ]),
            /exceptions require/,
        );
    }
    assert.throws(
        () =>
            assertPinnedInputAge(fresh, 30, now, [
                ...exceptions,
                ...exceptions,
            ]),
        /Duplicate/,
    );
});

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

test("cold GitHub inputs authenticate both provenance and verified archive requests", async () => {
    const options = await fixture();
    const token = "pinned-input-test-token";
    const publishedAt = "2020-01-01T00:00:00Z";
    const githubInput = {
        ...input,
        url: "https://api.github.com/repos/example/tools/releases/assets/1",
        releaseTag: "v1.0.0",
        assetName: input.fileName,
        publishedAt,
    };
    const mediaTypes = [];
    await materializePinnedInput({
        ...options,
        input: githubInput,
        environment: { [ENV_GITHUB_TOKEN]: token },
        verifyProvenance: verifyGithubReleaseInputProvenance,
        fetchImplementation: async (_url, request) => {
            assert.equal(request.headers.Authorization, `Bearer ${token}`);
            mediaTypes.push(request.headers.Accept);
            return request.headers.Accept === GITHUB_METADATA_MEDIA_TYPE
                ? Response.json({
                      tag_name: githubInput.releaseTag,
                      draft: false,
                      published_at: publishedAt,
                      assets: [
                          {
                              id: 1,
                              name: input.fileName,
                              size: input.sizeBytes,
                              created_at: publishedAt,
                              updated_at: publishedAt,
                          },
                      ],
                  })
                : new Response(content);
        },
    });
    assert.deepEqual(mediaTypes, [
        GITHUB_METADATA_MEDIA_TYPE,
        "application/octet-stream",
    ]);
    assert.deepEqual(await readFile(options.destinationPath), content);
});

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
