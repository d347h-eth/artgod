import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createArtifactRunDirectory, pinFile } from "./artifacts.mjs";
import {
    inspectToolImageArchive,
    TOOL_IMAGE_ARCHIVE_LIMITS,
} from "./tool-image-archive.mjs";

import {
    createToolImageArchiveFixture as layout,
    encodeToolImageArchiveFixture as tar,
    checksumToolImageArchiveFixtureHeader as checksum,
} from "./tool-image-archive-fixture.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const json = (value) => Buffer.from(JSON.stringify(value));
const blobName = (id) => `blobs/sha256/${id.slice("sha256:".length)}`;

async function persist(fixture, transform = (bytes) => bytes) {
    const directory = await createArtifactRunDirectory(
        path.join(ROOT, "tmp/simulation-tool-archive-tests"),
        "archive-",
    );
    const filename = path.join(directory, "tool-image.tar");
    const bytes = transform(tar(fixture.members));
    await writeFile(filename, bytes);
    return {
        directory,
        filename,
        input: {
            archive: await pinFile(filename),
            recordedImageId: fixture.recordedImageId,
        },
    };
}

async function rejectLayout(fixture, transform) {
    const f = await persist(fixture, transform);
    await assert.rejects(inspectToolImageArchive(f.input));
    assert.deepEqual(await readdir(f.directory), ["tool-image.tar"]);
}

test("a pinned OCI graph binds its recorded config to the immutable runtime manifest without extraction", async () => {
    const fixture = layout();
    const f = await persist(fixture);
    const before = await pinFile(f.filename);
    const result = await inspectToolImageArchive(f.input);
    assert.equal(result.recordedImageId, fixture.recordedImageId);
    assert.equal(result.runtimeImageId, fixture.runtimeImageId);
    assert.notEqual(result.recordedImageId, result.runtimeImageId);
    assert.deepEqual(result.manifest, fixture.manifestDescriptor);
    assert.deepEqual(result.config, fixture.configDescriptor);
    assert.deepEqual(result.rootfsDiffIds, fixture.config.rootfs.diff_ids);
    assert.deepEqual(result.layers, fixture.layers);
    assert.deepEqual(result.platform, { os: "linux", architecture: "amd64" });
    assert.deepEqual(result.archive, f.input.archive);
    assert.deepEqual(await pinFile(f.filename), before);
    assert.deepEqual(await readdir(f.directory), ["tool-image.tar"]);
});

test("another recorded config cannot borrow an otherwise valid manifest", async () => {
    const fixture = layout();
    const f = await persist(fixture);
    await assert.rejects(
        inspectToolImageArchive({
            ...f.input,
            recordedImageId: `sha256:${"ab".repeat(32)}`,
        }),
    );
});

for (const [label, changeConfig] of [
    ["another architecture", (value) => (value.architecture = "arm64")],
    ["another operating system", (value) => (value.os = "windows")],
    ["a different rootfs kind", (value) => (value.rootfs.type = "foreign")],
    ["reordered layer identities", (value) => value.rootfs.diff_ids.reverse()],
    ["missing layer identities", (value) => value.rootfs.diff_ids.pop()],
])
    test(`a content-valid config with ${label} cannot qualify the tool image`, async () => {
        await rejectLayout(layout({ changeConfig }));
    });

for (const [label, changeManifest] of [
    [
        "another config",
        (value) => (value.config.digest = `sha256:${"ab".repeat(32)}`),
    ],
    ["a wrong config byte length", (value) => value.config.size++],
    ["a wrong layer byte length", (value) => value.layers[0].size++],
    [
        "a compressed layer descriptor",
        (value) =>
            (value.layers[0].mediaType =
                "application/vnd.oci.image.layer.v1.tar+gzip"),
    ],
    ["an unsupported manifest version", (value) => (value.schemaVersion = 1)],
])
    test(`the manifest rejects ${label}`, async () => {
        await rejectLayout(layout({ changeManifest }));
    });

for (const [label, changeIndex] of [
    [
        "multiple candidate images",
        (value) => value.manifests.push(value.manifests[0]),
    ],
    ["no candidate image", (value) => (value.manifests = [])],
    [
        "a nested index",
        (value) =>
            (value.manifests[0].mediaType =
                "application/vnd.oci.image.index.v1+json"),
    ],
    ["a wrong manifest length", (value) => value.manifests[0].size++],
    [
        "a conflicting platform declaration",
        (value) =>
            (value.manifests[0].platform = {
                os: "linux",
                architecture: "arm64",
            }),
    ],
    [
        "an unsupported platform variant",
        (value) =>
            (value.manifests[0].platform = {
                os: "linux",
                architecture: "amd64",
                variant: "unknown",
            }),
    ],
])
    test(`the OCI index rejects ${label}`, async () => {
        await rejectLayout(layout({ changeIndex }));
    });

test("an explicit descriptor platform must agree with its pinned config", async () => {
    const fixture = layout({
        changeIndex: (value) => {
            value.manifests[0].platform = {
                os: "linux",
                architecture: "amd64",
            };
        },
    });
    const f = await persist(fixture);
    const result = await inspectToolImageArchive(f.input);
    assert.deepEqual(result.manifest.platform, {
        os: "linux",
        architecture: "amd64",
    });
});

for (const target of ["config", "manifest", "layer"])
    test(`a repinned outer archive cannot hide changed ${target} blob bytes`, async () => {
        const fixture = layout();
        const id =
            target === "config"
                ? fixture.recordedImageId
                : target === "manifest"
                  ? fixture.runtimeImageId
                  : fixture.layers[0].digest;
        const member = fixture.members.find(
            (entry) => entry.name === blobName(id),
        );
        member.data = Buffer.from(member.data);
        member.data[0] ^= 1;
        await rejectLayout(fixture);
    });

test("a referenced blob must exist rather than being inferred from its digest", async () => {
    const fixture = layout();
    fixture.members = fixture.members.filter(
        (entry) => entry.name !== blobName(fixture.configDescriptor.digest),
    );
    await rejectLayout(fixture);
});

for (const [label, mutate] of [
    ["another config", (legacy) => (legacy[0].Config = "blobs/sha256/other")],
    ["another layer order", (legacy) => legacy[0].Layers.reverse()],
    [
        "inconsistent layer metadata",
        (legacy, fixture) => {
            legacy[0].LayerSources = Object.fromEntries(
                fixture.layers.map((layer) => [layer.digest, { ...layer }]),
            );
            legacy[0].LayerSources[fixture.layers[0].digest].size++;
        },
    ],
])
    test(`the optional Docker manifest cannot hide ${label}`, async () => {
        const fixture = layout();
        const member = fixture.members.find(
            (entry) => entry.name === "manifest.json",
        );
        const legacy = JSON.parse(member.data);
        mutate(legacy, fixture);
        member.data = json(legacy);
        await rejectLayout(fixture);
    });

for (const [label, member] of [
    ["duplicate member", { name: "index.json", data: json({}) }],
    ["absolute member", { name: "/outside", data: Buffer.from("x") }],
    ["parent traversal", { name: "../outside", data: Buffer.from("x") }],
    [
        "embedded traversal",
        { name: "blobs/../outside", data: Buffer.from("x") },
    ],
    ["symbolic link", { name: "alias", type: "2", link: "index.json" }],
    ["hard link", { name: "alias", type: "1", link: "index.json" }],
])
    test(`an archive containing a ${label} is rejected without extraction`, async () => {
        const fixture = layout();
        fixture.members.push(member);
        await rejectLayout(fixture);
    });

test("an invalid TAR checksum is rejected before its otherwise matching graph", async () => {
    await rejectLayout(layout(), (bytes) => {
        bytes[0] ^= 1;
        return bytes;
    });
});

test("a truncated TAR header cannot qualify a pinned archive", async () => {
    await rejectLayout(layout(), (bytes) => bytes.subarray(0, 100));
});

test("a member range outside the archive cannot qualify even with a valid header checksum", async () => {
    await rejectLayout(layout(), (bytes) => {
        bytes.write("77777777777\0", 124, "ascii");
        checksum(bytes.subarray(0, 512));
        return bytes;
    });
});

test("non-octal TAR sizes are rejected rather than parsed as a smaller prefix", async () => {
    await rejectLayout(layout(), (bytes) => {
        bytes.write("0000000008\0", 124, "ascii");
        checksum(bytes.subarray(0, 512));
        return bytes;
    });
});

test("the complete two-block TAR terminator is required", async () => {
    await rejectLayout(layout(), (bytes) =>
        bytes.subarray(0, bytes.length - 512),
    );
});

test("nonzero member padding is rejected instead of skipped as hidden archive data", async () => {
    const fixture = layout();
    const metadata = fixture.members.find(
        (entry) => entry.name === "oci-layout",
    );
    await rejectLayout(fixture, (bytes) => {
        // Two directory headers precede this regular file's header and payload.
        bytes[3 * 512 + metadata.data.length] = 1;
        return bytes;
    });
});

test("JSON admission and member-count limits reject excess work without extracting", async () => {
    await rejectLayout(
        layout({
            changeConfig(config) {
                config.padding = "x".repeat(
                    TOOL_IMAGE_ARCHIVE_LIMITS.jsonBytes,
                );
            },
        }),
    );
    const fixture = layout();
    for (let i = 0; i < TOOL_IMAGE_ARCHIVE_LIMITS.memberCount; i++)
        fixture.members.push({ name: `extra-${i}/`, type: "5" });
    await rejectLayout(fixture);
});

test("admission rejects stale size or digest pins before trusting archive contents", async () => {
    const fixture = layout();
    const f = await persist(fixture);
    for (const archive of [
        { ...f.input.archive, sizeBytes: f.input.archive.sizeBytes + 1 },
        { ...f.input.archive, sha256: "ab".repeat(32) },
        {
            ...f.input.archive,
            sizeBytes: TOOL_IMAGE_ARCHIVE_LIMITS.archiveBytes + 1,
        },
    ])
        await assert.rejects(inspectToolImageArchive({ ...f.input, archive }));
    await writeFile(f.filename, Buffer.alloc(f.input.archive.sizeBytes, 1));
    await assert.rejects(inspectToolImageArchive(f.input));
});
