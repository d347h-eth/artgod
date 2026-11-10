// Synthetic test-only OCI/TAR fixtures; these bytes never qualify a runtime.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const JSON_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const JSON_INDEX = "application/vnd.oci.image.index.v1+json";
const JSON_CONFIG = "application/vnd.oci.image.config.v1+json";
const TAR_LAYER = "application/vnd.oci.image.layer.v1.tar";
const digest = (bytes) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (value) => Buffer.from(JSON.stringify(value));
const blobName = (id) => `blobs/sha256/${id.slice("sha256:".length)}`;

// This test writer constructs POSIX TAR bytes directly. It never calls the
// archive inspector or Docker to derive the expected content-addressed graph.
export function checksumToolImageArchiveFixtureHeader(header) {
    header.fill(0x20, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}

function tarHeader({ name, data = Buffer.alloc(0), type = "0", link = "" }) {
    assert.ok(Buffer.byteLength(name) <= 100);
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    for (const [offset, width, value] of [
        [100, 8, 0o644],
        [108, 8, 1000],
        [116, 8, 1000],
        [124, 12, data.length],
        [136, 12, 0],
    ])
        header.write(
            `${value.toString(8).padStart(width - 1, "0")}\0`,
            offset,
            "ascii",
        );
    header.write(type, 156, "ascii");
    header.write(link, 157, "utf8");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    checksumToolImageArchiveFixtureHeader(header);
    return header;
}

export function encodeToolImageArchiveFixture(members) {
    const blocks = [];
    for (const member of members) {
        const data = member.data ?? Buffer.alloc(0);
        blocks.push(tarHeader({ ...member, data }), data);
        if (data.length % 512)
            blocks.push(Buffer.alloc(512 - (data.length % 512)));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

export function createToolImageArchiveFixture({
    changeConfig,
    changeManifest,
    changeIndex,
} = {}) {
    const layerBytes = [
        encodeToolImageArchiveFixture([
            {
                name: "usr/bin/qemu-system-x86_64",
                data: Buffer.from("independent synthetic emulator bytes"),
            },
        ]),
        encodeToolImageArchiveFixture([
            {
                name: "usr/lib/synthetic-runtime.so",
                data: Buffer.from("independent synthetic runtime bytes"),
            },
        ]),
    ];
    const layers = layerBytes.map((bytes) => ({
        mediaType: TAR_LAYER,
        digest: digest(bytes),
        size: bytes.length,
    }));
    const config = {
        architecture: "amd64",
        os: "linux",
        config: {
            Env: ["LANG=C", "LC_ALL=C", "TZ=UTC"],
            Cmd: ["/usr/bin/true"],
        },
        rootfs: {
            type: "layers",
            diff_ids: layers.map((layer) => layer.digest),
        },
    };
    changeConfig?.(config);
    const configBytes = json(config);
    const configId = digest(configBytes);
    const configDescriptor = {
        mediaType: JSON_CONFIG,
        digest: configId,
        size: configBytes.length,
    };
    const manifest = {
        schemaVersion: 2,
        mediaType: JSON_MANIFEST,
        config: configDescriptor,
        layers,
    };
    changeManifest?.(manifest);
    const manifestBytes = json(manifest);
    const manifestDescriptor = {
        mediaType: JSON_MANIFEST,
        digest: digest(manifestBytes),
        size: manifestBytes.length,
    };
    const index = {
        schemaVersion: 2,
        mediaType: JSON_INDEX,
        manifests: [manifestDescriptor],
    };
    changeIndex?.(index);
    const fixture = {
        recordedImageId: configId,
        runtimeImageId: manifestDescriptor.digest,
        config,
        configDescriptor,
        manifestDescriptor,
        layers,
        members: [
            { name: "blobs/", type: "5" },
            { name: "blobs/sha256/", type: "5" },
            { name: "oci-layout", data: json({ imageLayoutVersion: "1.0.0" }) },
            { name: "index.json", data: json(index) },
            { name: blobName(configId), data: configBytes },
            { name: blobName(manifestDescriptor.digest), data: manifestBytes },
            ...layerBytes.map((data, i) => ({
                name: blobName(layers[i].digest),
                data,
            })),
            // Docker save can retain both its compatibility manifest and OCI
            // graph. Admission must not mistake the former for another image.
            {
                name: "manifest.json",
                data: json([
                    {
                        Config: blobName(configDescriptor.digest),
                        RepoTags: null,
                        Layers: layers.map((layer) => blobName(layer.digest)),
                    },
                ]),
            },
        ],
    };
    return {
        ...fixture,
        bytes: encodeToolImageArchiveFixture(fixture.members),
        manifest,
        layerDigests: layers.map((layer) => layer.digest),
    };
}
