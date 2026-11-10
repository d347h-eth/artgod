import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./artifacts.mjs";

export const TOOL_IMAGE_ARCHIVE_LIMITS = Object.freeze({
    archiveBytes: 2 * 1024 ** 3,
    memberCount: 512,
    jsonBytes: 1024 ** 2,
});
const MEDIA = Object.freeze({
    Index: "application/vnd.oci.image.index.v1+json",
    Manifest: "application/vnd.oci.image.manifest.v1+json",
    Config: "application/vnd.oci.image.config.v1+json",
    Layer: "application/vnd.oci.image.layer.v1.tar",
});
const digest = /^sha256:[a-f0-9]{64}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reject = (message) => {
    throw new Error(`Tool image archive ${message}`);
};
const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value);

function octal(bytes) {
    const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
    if (!/^[0-7]+$/.test(text)) reject("has an unsupported TAR number");
    const number = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(number)) reject("has an overflowing TAR number");
    return number;
}

function descriptor(value, mediaType) {
    if (
        !object(value) ||
        value.mediaType !== mediaType ||
        !digest.test(value.digest ?? "") ||
        !Number.isSafeInteger(value.size) ||
        value.size < 1
    )
        reject("has an unsupported descriptor");
    return value;
}

/** Read the saved bytes without extracting files or invoking another executable.
 * Only the observed single-manifest, uncompressed OCI graph is a compatibility
 * path. Other archive formats still require the exact original daemon address.
 */
export async function inspectToolImageArchive({ archive, recordedImageId }) {
    if (
        !object(archive) ||
        typeof archive.path !== "string" ||
        !/^[a-f0-9]{64}$/.test(archive.sha256 ?? "") ||
        !Number.isSafeInteger(archive.sizeBytes) ||
        archive.sizeBytes < 1024 ||
        archive.sizeBytes > TOOL_IMAGE_ARCHIVE_LIMITS.archiveBytes ||
        archive.sizeBytes % 512 !== 0 ||
        !digest.test(recordedImageId ?? "")
    )
        reject("requires bounded pinned bytes and a recorded image ID");
    const before = await lstat(archive.path);
    if (!before.isFile() || before.size !== archive.sizeBytes)
        reject("must be a regular file with its pinned size");
    if ((await hashFile(archive.path)) !== archive.sha256)
        reject("bytes changed before admission");
    const file = await open(archive.path, "r");
    try {
        const opened = await file.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino)
            reject("file changed while opening");
        const read = async (offset, length) => {
            if (
                !Number.isSafeInteger(offset + length) ||
                offset < 0 ||
                length < 0 ||
                offset + length > archive.sizeBytes
            )
                reject("has a truncated member range");
            const bytes = Buffer.alloc(length);
            let used = 0;
            while (used < length) {
                const { bytesRead } = await file.read(
                    bytes,
                    used,
                    length - used,
                    offset + used,
                );
                if (!bytesRead) reject("is truncated");
                used += bytesRead;
            }
            return bytes;
        };
        const hashRange = async (offset, length) => {
            const hash = createHash("sha256");
            for (let used = 0; used < length; ) {
                const bytes = await read(
                    offset + used,
                    Math.min(64 * 1024, length - used),
                );
                hash.update(bytes);
                used += bytes.length;
            }
            return hash.digest("hex");
        };
        const members = new Map();
        let offset = 0;
        let ended = false;
        while (offset < archive.sizeBytes) {
            const header = await read(offset, 512);
            if (header.every((byte) => byte === 0)) {
                const next = await read(offset + 512, 512);
                if (!next.every((byte) => byte === 0))
                    reject("has an invalid TAR terminator");
                for (
                    let tail = offset + 1024;
                    tail < archive.sizeBytes;
                    tail += 64 * 1024
                )
                    if (
                        !(
                            await read(
                                tail,
                                Math.min(64 * 1024, archive.sizeBytes - tail),
                            )
                        ).every((byte) => byte === 0)
                    )
                        reject("has nonzero trailing TAR content");
                ended = true;
                break;
            }
            if (members.size >= TOOL_IMAGE_ARCHIVE_LIMITS.memberCount)
                reject("member count exceeds its limit");
            if (
                !header.subarray(257, 263).toString("ascii").startsWith("ustar")
            )
                reject("requires USTAR headers");
            const checksum = header.reduce(
                (sum, byte, index) =>
                    sum + (index >= 148 && index < 156 ? 32 : byte),
                0,
            );
            if (octal(header.subarray(148, 156)) !== checksum)
                reject("has an invalid TAR checksum");
            const text = (start, end) =>
                header
                    .subarray(start, end)
                    .toString("utf8")
                    .replace(/\0.*$/, "");
            const name = [text(345, 500), text(0, 100)]
                .filter(Boolean)
                .join("/")
                .replace(/\/$/, "");
            const size = octal(header.subarray(124, 136));
            const type = header[156];
            if (
                !name ||
                path.posix.isAbsolute(name) ||
                path.posix.normalize(name) !== name ||
                name === ".." ||
                name.startsWith("../") ||
                /[\x00-\x1f\\]/.test(name) ||
                ![0, 48, 53].includes(type) ||
                (type === 53 && size !== 0)
            )
                reject("has an unsafe or unsupported TAR member");
            if (members.has(name)) reject("has duplicate TAR members");
            const body = offset + 512;
            const end = body + Math.ceil(size / 512) * 512;
            if (!Number.isSafeInteger(end) || end > archive.sizeBytes)
                reject("has a truncated member range");
            const member = { offset: body, size, directory: type === 53 };
            if (
                !(await read(body + size, end - body - size)).every(
                    (byte) => byte === 0,
                )
            )
                reject("has nonzero member padding");
            if (!member.directory) {
                member.sha256 = await hashRange(body, size);
                if (
                    name.startsWith("blobs/") &&
                    name !== `blobs/sha256/${member.sha256}`
                )
                    reject("has a blob digest mismatch");
            }
            members.set(name, member);
            offset = end;
        }
        if (!ended) reject("has no complete TAR terminator");
        const json = async (name) => {
            const member = members.get(name);
            if (
                !member ||
                member.directory ||
                member.size > TOOL_IMAGE_ARCHIVE_LIMITS.jsonBytes
            )
                reject("has missing or oversized JSON metadata");
            const bytes = await read(member.offset, member.size);
            if (sha256(bytes) !== member.sha256)
                reject("metadata changed during admission");
            return JSON.parse(bytes.toString("utf8"));
        };
        const blob = async (value, mediaType) => {
            const d = descriptor(value, mediaType);
            const name = `blobs/sha256/${d.digest.slice(7)}`;
            const member = members.get(name);
            if (
                !member ||
                member.directory ||
                member.size !== d.size ||
                member.sha256 !== d.digest.slice(7)
            )
                reject("descriptor does not match its blob");
            return name;
        };
        const layout = await json("oci-layout");
        if (layout.imageLayoutVersion !== "1.0.0")
            reject("has an unsupported OCI layout");
        const index = await json("index.json");
        if (
            index.schemaVersion !== 2 ||
            index.mediaType !== MEDIA.Index ||
            !Array.isArray(index.manifests) ||
            index.manifests.length !== 1
        )
            reject("requires one unambiguous OCI manifest");
        const manifestDescriptor = descriptor(
            index.manifests[0],
            MEDIA.Manifest,
        );
        const manifest = await json(
            await blob(manifestDescriptor, MEDIA.Manifest),
        );
        if (
            manifest.schemaVersion !== 2 ||
            manifest.mediaType !== MEDIA.Manifest ||
            !Array.isArray(manifest.layers) ||
            !manifest.layers.length
        )
            reject("has an unsupported image manifest");
        const configDescriptor = descriptor(manifest.config, MEDIA.Config);
        if (configDescriptor.digest !== recordedImageId)
            reject("config digest differs from the recorded image ID");
        const configPath = await blob(configDescriptor, MEDIA.Config);
        const config = await json(configPath);
        if (
            config.architecture !== "amd64" ||
            config.os !== "linux" ||
            config.rootfs?.type !== "layers" ||
            !Array.isArray(config.rootfs.diff_ids) ||
            config.rootfs.diff_ids.length !== manifest.layers.length
        )
            reject("has an unsupported platform or ordered rootfs");
        const declaredPlatform = manifestDescriptor.platform;
        if (
            declaredPlatform !== undefined &&
            (!object(declaredPlatform) ||
                declaredPlatform.os !== config.os ||
                declaredPlatform.architecture !== config.architecture ||
                declaredPlatform.variant !== undefined)
        )
            reject("manifest descriptor platform disagrees with its config");
        const layerPaths = [];
        for (const [i, layer] of manifest.layers.entries()) {
            layerPaths.push(await blob(layer, MEDIA.Layer));
            if (config.rootfs.diff_ids[i] !== layer.digest)
                reject("ordered rootfs differs from its uncompressed layers");
        }
        if (members.has("manifest.json")) {
            const legacy = await json("manifest.json");
            if (
                !Array.isArray(legacy) ||
                legacy.length !== 1 ||
                legacy[0].Config !== configPath ||
                JSON.stringify(legacy[0].Layers) !== JSON.stringify(layerPaths)
            )
                reject("Docker manifest disagrees with its OCI graph");
            if (legacy[0].LayerSources !== undefined)
                for (const layer of manifest.layers) {
                    const source = legacy[0].LayerSources[layer.digest];
                    if (
                        !source ||
                        source.digest !== layer.digest ||
                        source.size !== layer.size ||
                        source.mediaType !== layer.mediaType
                    )
                        reject(
                            "Docker layer descriptor disagrees with its OCI graph",
                        );
                }
        }
        const after = await lstat(archive.path);
        if (
            !after.isFile() ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            (await hashFile(archive.path)) !== archive.sha256
        )
            reject("bytes changed during admission");
        return {
            archive: { ...archive, path: path.resolve(archive.path) },
            recordedImageId,
            runtimeImageId: manifestDescriptor.digest,
            manifest: manifestDescriptor,
            config: configDescriptor,
            rootfsDiffIds: config.rootfs.diff_ids,
            layers: manifest.layers,
            platform: { os: config.os, architecture: config.architecture },
        };
    } finally {
        await file.close();
    }
}
