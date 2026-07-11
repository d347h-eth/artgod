#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createSecretRedactor } from "./secret-output-redaction.mjs";
import {
    assertGitHubJsonRecord,
    createGitHubApiUrl,
    ENV_GITHUB_REF_NAME,
    ENV_GITHUB_REPOSITORY,
    ENV_GITHUB_TOKEN,
    ENV_GH_TOKEN,
    parseGitHubRepository,
    requestGitHubJson,
    requireEnvironmentValue,
    resolveGitHubApiBaseUrl,
} from "./github-api.mjs";

const COMMAND_PUBLISH = "publish";
const ENV_STAGED_RELEASE_ID = "STAGED_GITHUB_RELEASE_ID";
const ENV_RELEASE_PRERELEASE = "RELEASE_PRERELEASE";
const ENV_RELEASE_MAKE_LATEST = "RELEASE_MAKE_LATEST";
const RELEASE_ASSET_STATE_UPLOADED = "uploaded";
const RELEASE_ID_PATTERN = /^[1-9][0-9]*$/;
const MAKE_LATEST_VALUES = new Set(["true", "false"]);

// Publishes only the validated draft returned by the asset-staging Action.
export async function publishStagedGitHubRelease(options = {}) {
    const environment = options.environment ?? process.env;
    const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    const repository = parseGitHubRepository(
        requireEnvironmentValue(environment, ENV_GITHUB_REPOSITORY),
    );
    const githubToken = requireEnvironmentValue(environment, ENV_GITHUB_TOKEN);
    const tagName = requireEnvironmentValue(environment, ENV_GITHUB_REF_NAME);
    const releaseId = parseReleaseId(
        requireEnvironmentValue(environment, ENV_STAGED_RELEASE_ID),
    );
    const prerelease = parseBoolean(
        requireEnvironmentValue(environment, ENV_RELEASE_PRERELEASE),
        ENV_RELEASE_PRERELEASE,
    );
    const makeLatest = parseMakeLatest(
        requireEnvironmentValue(environment, ENV_RELEASE_MAKE_LATEST),
    );
    assertReleaseChannel(prerelease, makeLatest);

    const releaseUrl = createGitHubApiUrl(
        resolveGitHubApiBaseUrl(environment),
        repository,
        `releases/${releaseId}`,
    );

    // Validate the exact staged draft before the irreversible publication call.
    const stagedRelease = await requestGitHubJson(
        fetchImplementation,
        releaseUrl,
        githubToken,
        "staged release validation",
    );
    const assetCount = assertStagedRelease(
        stagedRelease,
        releaseId,
        tagName,
        prerelease,
    );

    // Publish by numeric release ID so tag lookup cannot create a duplicate.
    const publishedRelease = await requestGitHubJson(
        fetchImplementation,
        releaseUrl,
        githubToken,
        "staged release publication",
        {
            method: "PATCH",
            body: {
                draft: false,
                prerelease,
                make_latest: makeLatest,
            },
        },
    );
    assertPublishedRelease(
        publishedRelease,
        releaseId,
        tagName,
        prerelease,
        assetCount,
    );

    return Object.freeze({ releaseId, tagName, prerelease, assetCount });
}

function assertStagedRelease(release, releaseId, tagName, prerelease) {
    assertReleaseIdentity(release, releaseId, tagName, prerelease);
    if (release.draft !== true) {
        throw new Error("Staged GitHub release is not a draft.");
    }
    if (!Array.isArray(release.assets) || release.assets.length === 0) {
        throw new Error("Staged GitHub release has no uploaded assets.");
    }
    for (const asset of release.assets) {
        assertGitHubJsonRecord(asset, "GitHub release asset");
        if (asset.state !== RELEASE_ASSET_STATE_UPLOADED) {
            throw new Error(
                "Staged GitHub release contains an incomplete asset.",
            );
        }
    }
    return release.assets.length;
}

function assertPublishedRelease(
    release,
    releaseId,
    tagName,
    prerelease,
    expectedAssetCount,
) {
    assertReleaseIdentity(release, releaseId, tagName, prerelease);
    if (release.draft !== false) {
        throw new Error("GitHub release remained a draft after publication.");
    }
    if (release.immutable !== true) {
        throw new Error("Published GitHub release is not immutable.");
    }
    if (
        !Array.isArray(release.assets) ||
        release.assets.length !== expectedAssetCount
    ) {
        throw new Error(
            "Published GitHub release assets differ from the staged draft.",
        );
    }
}

function assertReleaseIdentity(release, releaseId, tagName, prerelease) {
    assertGitHubJsonRecord(release, "GitHub release");
    if (release.id !== releaseId) {
        throw new Error("GitHub returned a different numeric release ID.");
    }
    if (release.tag_name !== tagName) {
        throw new Error("GitHub release tag does not match the workflow tag.");
    }
    if (release.prerelease !== prerelease) {
        throw new Error(
            "GitHub release channel does not match release metadata.",
        );
    }
}

function parseReleaseId(value) {
    if (!RELEASE_ID_PATTERN.test(value)) {
        throw new Error(
            `${ENV_STAGED_RELEASE_ID} must be a positive integer release ID.`,
        );
    }
    const releaseId = Number(value);
    if (!Number.isSafeInteger(releaseId)) {
        throw new Error(`${ENV_STAGED_RELEASE_ID} exceeds integer precision.`);
    }
    return releaseId;
}

function parseBoolean(value, environmentKey) {
    if (value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    throw new Error(`${environmentKey} must be true or false.`);
}

function parseMakeLatest(value) {
    if (!MAKE_LATEST_VALUES.has(value)) {
        throw new Error(`${ENV_RELEASE_MAKE_LATEST} must be true or false.`);
    }
    return value;
}

function assertReleaseChannel(prerelease, makeLatest) {
    if (prerelease && makeLatest !== "false") {
        throw new Error("A GitHub pre-release cannot be marked Latest.");
    }
    if (!prerelease && makeLatest !== "true") {
        throw new Error("A stable GitHub release must be marked Latest.");
    }
}

// Redacts the workflow token from all public publication failures.
export function formatReleasePublicationFailure(error, environment) {
    try {
        const redactor = createSecretRedactor([
            environment[ENV_GITHUB_TOKEN],
            environment[ENV_GH_TOKEN],
        ]);
        return redactor.redact(
            error instanceof Error ? error.stack : String(error),
        );
    } catch {
        return "GitHub release publication failed before a safe output redactor could be created.";
    }
}

async function main() {
    if (process.argv[2] !== COMMAND_PUBLISH) {
        throw new Error(
            `Usage: node scripts/build/github-release-publication.mjs ${COMMAND_PUBLISH}`,
        );
    }
    const result = await publishStagedGitHubRelease();
    console.log(
        `Published staged GitHub release ${result.releaseId} for ${result.tagName} with ${result.assetCount} assets.`,
    );
}

const isMainModule =
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
    try {
        await main();
    } catch (error) {
        console.error(formatReleasePublicationFailure(error, process.env));
        process.exitCode = 1;
    }
}
