import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import {
    DEFAULT_MINIMUM_AGE_DAYS,
    calculateCutoffDate,
} from "../security/dependency-age-policy.mjs";

export const GITHUB_METADATA_MEDIA_TYPE = "application/vnd.github+json";
export const GITHUB_RELEASE_ASSET_URL_PATTERN =
    /^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases\/assets\/[1-9][0-9]*$/;
const BINARY_DOWNLOAD_MEDIA_TYPE = "application/octet-stream";
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// A reviewed timestamp must be unambiguous and represent a real UTC instant.
export function assertInputPublicationTimestamp(value, fileName) {
    const timestamp = new Date(value);
    if (
        typeof value !== "string" ||
        !UTC_TIMESTAMP_PATTERN.test(value) ||
        Number.isNaN(timestamp.getTime()) ||
        timestamp.toISOString().replace(".000Z", "Z") !== value
    ) {
        throw new Error(
            `Pinned input ${fileName} has an invalid publication timestamp.`,
        );
    }
}

// Admission applies before cache inspection, so warm caches cannot bypass age policy.
export function assertPinnedInputAge(input, minimumAgeDays, now = new Date()) {
    if (
        !Number.isSafeInteger(minimumAgeDays) ||
        minimumAgeDays < DEFAULT_MINIMUM_AGE_DAYS
    ) {
        throw new Error(
            `Pinned inputs require a minimum age of at least ${DEFAULT_MINIMUM_AGE_DAYS} days.`,
        );
    }
    assertInputPublicationTimestamp(input.publishedAt, input.fileName);
    const cutoff = calculateCutoffDate(now, minimumAgeDays);
    if (!Number.isFinite(cutoff.getTime()))
        throw new Error("Pinned inputs have an invalid age cutoff.");
    if (new Date(input.publishedAt) > cutoff) {
        throw new Error(
            `Pinned input ${input.fileName} was published ${input.publishedAt}; the ${minimumAgeDays}-day age gate requires publication on or before ${cutoff.toISOString()}.`,
        );
    }
}

// Shared byte contract for cached packaging tools and application runtime archives.
export function assertPinnedInputBytesContract(input) {
    if (
        !input ||
        typeof input !== "object" ||
        typeof input.fileName !== "string" ||
        !input.fileName ||
        input.fileName === "." ||
        input.fileName === ".." ||
        /[\\/]/.test(input.fileName) ||
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(input.sha256 ?? "")
    ) {
        throw new Error(
            "Pinned input requires a file name, positive size and SHA-256.",
        );
    }
}

async function matchesPinnedBytes(filePath, input) {
    let metadata;
    try {
        metadata = await lstat(filePath);
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
    if (!metadata.isFile() || metadata.size !== input.sizeBytes) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex") === input.sha256;
}

// Publish only complete verified downloads. Existing bytes are rehashed on every use.
export async function materializePinnedInput({
    input,
    destinationPath,
    temporaryDirectory,
    verifyProvenance,
    fetchImplementation = fetch,
    mode = 0o600,
}) {
    assertPinnedInputBytesContract(input);
    if (await matchesPinnedBytes(destinationPath, input)) {
        await chmod(destinationPath, mode);
        return destinationPath;
    }
    await verifyProvenance(input, fetchImplementation);
    const response = await fetchImplementation(input.url, {
        headers: { Accept: BINARY_DOWNLOAD_MEDIA_TYPE },
    });
    if (!response.ok || !response.body) {
        throw new Error(
            `Failed to download pinned input ${input.fileName}: HTTP ${response.status}.`,
        );
    }
    const downloadDirectory = await mkdtemp(
        path.join(temporaryDirectory, "input-"),
    );
    const temporaryPath = path.join(downloadDirectory, input.fileName);
    const hash = createHash("sha256");
    let size = 0;
    const verifyStream = new Transform({
        transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > input.sizeBytes) {
                callback(
                    new Error(`Pinned input ${input.fileName} size mismatch.`),
                );
                return;
            }
            hash.update(chunk);
            callback(null, chunk);
        },
    });
    try {
        await pipeline(
            Readable.fromWeb(response.body),
            verifyStream,
            createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
        );
        if (size !== input.sizeBytes)
            throw new Error(`Pinned input ${input.fileName} size mismatch.`);
        if (hash.digest("hex") !== input.sha256)
            throw new Error(`Pinned input ${input.fileName} SHA-256 mismatch.`);
        await chmod(temporaryPath, mode);
        await rename(temporaryPath, destinationPath);
    } finally {
        await rm(downloadDirectory, { recursive: true, force: true });
    }
    return destinationPath;
}

// A fixed GitHub asset must belong to the retained release and retain its upload date.
export async function verifyGithubReleaseInputProvenance(
    input,
    fetchImplementation = fetch,
) {
    if (!GITHUB_RELEASE_ASSET_URL_PATTERN.test(input.url)) {
        throw new Error(
            `Pinned input ${input.fileName} must use a GitHub release asset ID URL.`,
        );
    }
    const parts = new URL(input.url).pathname.split("/");
    const repository = `${parts[2]}/${parts[3]}`;
    const response = await fetchImplementation(
        `https://api.github.com/repos/${repository}/releases/tags/${input.releaseTag}`,
        { headers: { Accept: GITHUB_METADATA_MEDIA_TYPE } },
    );
    if (!response.ok)
        throw new Error(
            `Failed to verify pinned input ${input.fileName} provenance: HTTP ${response.status}.`,
        );
    const metadata = await response.json();
    const asset = metadata.assets?.find(
        (candidate) => candidate.id === Number(parts.at(-1)),
    );
    if (
        metadata.tag_name !== input.releaseTag ||
        metadata.draft !== false ||
        !asset ||
        asset.name !== input.assetName ||
        asset.size !== input.sizeBytes ||
        (input.sourceRevision &&
            metadata.target_commitish !== input.sourceRevision) ||
        (asset.digest && asset.digest !== `sha256:${input.sha256}`)
    ) {
        throw new Error(
            `Pinned input ${input.fileName} release asset metadata mismatch.`,
        );
    }
    const dates = [metadata.published_at, asset.created_at, asset.updated_at];
    for (const value of dates)
        assertInputPublicationTimestamp(value, input.fileName);
    const publishedAt = dates.sort().at(-1);
    if (publishedAt !== input.publishedAt) {
        throw new Error(
            `Pinned input ${input.fileName} publication timestamp mismatch: expected ${input.publishedAt}, received ${publishedAt}.`,
        );
    }
}
