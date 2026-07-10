#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSecretRedactor } from "./secret-output-redaction.mjs";
import {
    classifyReleaseTag,
    RELEASE_TAG_REF_TYPE,
} from "./desktop-release-contract.mjs";
import { assertProjectVersionsSynchronized } from "./sync-version.mjs";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const execFileAsync = promisify(execFile);

const COMMAND_VALIDATE = "validate";
const COMMAND_METADATA = "metadata";
const RELEASE_TAG_REF_PREFIX = "refs/tags/";
const REMOTE_MAIN_REF = "refs/remotes/origin/main";
const GIT_OBJECT_TYPE_COMMIT = "commit";
const GITHUB_VERIFICATION_REASON_VALID = "valid";
const PGP_SIGNATURE_BEGIN = "-----BEGIN PGP SIGNATURE-----";
const GITHUB_API_VERSION = "2026-03-10";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const GIT_OBJECT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const GITHUB_API_TIMEOUT_MS = 30 * 1000;

const ENV_GITHUB_API_URL = "GITHUB_API_URL";
const ENV_GITHUB_OUTPUT = "GITHUB_OUTPUT";
const ENV_GITHUB_REF = "GITHUB_REF";
const ENV_GITHUB_REF_NAME = "GITHUB_REF_NAME";
const ENV_GITHUB_REF_TYPE = "GITHUB_REF_TYPE";
const ENV_GITHUB_REPOSITORY = "GITHUB_REPOSITORY";
const ENV_GITHUB_SHA = "GITHUB_SHA";
const ENV_GITHUB_TOKEN = "GITHUB_TOKEN";
const ENV_GH_TOKEN = "GH_TOKEN";
const OUTPUT_PRERELEASE = "prerelease";
const OUTPUT_MAKE_LATEST = "make_latest";

// Verifies tag shape, GitHub's PGP result, checkout identity, and main ancestry.
export async function validateReleaseAdmission(options = {}) {
    const environment = options.environment ?? process.env;
    const projectRoot = options.projectRoot ?? rootDir;
    const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    const gitRunner = options.gitRunner ?? runGit;
    const projectVersion = await assertProjectVersionsSynchronized(projectRoot);
    const tagName = requireEnvironmentValue(environment, ENV_GITHUB_REF_NAME);
    const classification = classifyReleaseTag(tagName, projectVersion);

    assertReleaseTagContext(environment, tagName);
    const repository = parseRepository(
        requireEnvironmentValue(environment, ENV_GITHUB_REPOSITORY),
    );
    const githubToken = requireEnvironmentValue(environment, ENV_GITHUB_TOKEN);
    const apiBaseUrl =
        environment[ENV_GITHUB_API_URL]?.trim() || DEFAULT_GITHUB_API_URL;

    // Resolve the ref first so lightweight tags cannot enter release jobs.
    const reference = await requestGitHubJson(
        fetchImplementation,
        createGitHubApiUrl(
            apiBaseUrl,
            repository,
            `git/ref/tags/${encodeURIComponent(tagName)}`,
        ),
        githubToken,
        "release tag reference",
    );
    const tagObjectSha = assertAnnotatedTagReference(reference, tagName);

    // Ask GitHub for its cryptographic verification of the annotated tag.
    const tagObject = await requestGitHubJson(
        fetchImplementation,
        createGitHubApiUrl(apiBaseUrl, repository, `git/tags/${tagObjectSha}`),
        githubToken,
        "annotated release tag",
    );
    const targetCommit = assertVerifiedTagObject(
        tagObject,
        tagName,
        tagObjectSha,
    );

    const eventSha = normalizeGitObjectSha(
        requireEnvironmentValue(environment, ENV_GITHUB_SHA),
        ENV_GITHUB_SHA,
    );
    if (eventSha !== targetCommit) {
        throw new Error(
            "GitHub release event SHA does not match the signed tag target commit.",
        );
    }

    const gitEnvironment = createGitEnvironment(environment);
    const headResult = await gitRunner(["rev-parse", "HEAD"], {
        cwd: projectRoot,
        env: gitEnvironment,
    });
    const checkedOutCommit = normalizeGitObjectSha(
        headResult.stdout,
        "checked-out HEAD",
    );
    if (checkedOutCommit !== targetCommit) {
        throw new Error(
            "Checked-out HEAD does not match the signed tag target commit.",
        );
    }

    try {
        await gitRunner(
            ["merge-base", "--is-ancestor", targetCommit, REMOTE_MAIN_REF],
            { cwd: projectRoot, env: gitEnvironment },
        );
    } catch {
        throw new Error(
            `Signed release commit ${targetCommit} is not an ancestor of ${REMOTE_MAIN_REF}.`,
        );
    }

    return Object.freeze({
        ...classification,
        projectVersion,
        targetCommit,
    });
}

// Writes the centralized release-channel decision to GitHub step outputs.
export async function writeReleaseMetadata(environment, projectRoot = rootDir) {
    const projectVersion = await assertProjectVersionsSynchronized(projectRoot);
    const tagName = requireEnvironmentValue(environment, ENV_GITHUB_REF_NAME);
    assertReleaseTagContext(environment, tagName);
    const classification = classifyReleaseTag(tagName, projectVersion);
    const outputPath = requireEnvironmentValue(environment, ENV_GITHUB_OUTPUT);
    await appendFile(
        outputPath,
        [
            `${OUTPUT_PRERELEASE}=${classification.isTestRelease}`,
            `${OUTPUT_MAKE_LATEST}=${!classification.isTestRelease}`,
            "",
        ].join("\n"),
        "utf8",
    );
    return classification;
}

function assertReleaseTagContext(environment, tagName) {
    const refType = requireEnvironmentValue(environment, ENV_GITHUB_REF_TYPE);
    if (refType !== RELEASE_TAG_REF_TYPE) {
        throw new Error("Desktop releases must run from a Git tag ref.");
    }
    const expectedRef = `${RELEASE_TAG_REF_PREFIX}${tagName}`;
    if (requireEnvironmentValue(environment, ENV_GITHUB_REF) !== expectedRef) {
        throw new Error(`Desktop release ref must be ${expectedRef}.`);
    }
}

function assertAnnotatedTagReference(reference, tagName) {
    assertRecord(reference, "GitHub tag reference");
    if (reference.ref !== `${RELEASE_TAG_REF_PREFIX}${tagName}`) {
        throw new Error("GitHub returned a different release tag reference.");
    }
    assertRecord(reference.object, "GitHub tag reference object");
    if (reference.object.type !== RELEASE_TAG_REF_TYPE) {
        throw new Error(
            "Release tag must be an annotated tag, not a lightweight tag.",
        );
    }
    return normalizeGitObjectSha(reference.object.sha, "annotated tag object");
}

function assertVerifiedTagObject(tagObject, tagName, expectedTagObjectSha) {
    assertRecord(tagObject, "GitHub annotated tag object");
    if (
        normalizeGitObjectSha(tagObject.sha, "annotated tag object") !==
        expectedTagObjectSha
    ) {
        throw new Error(
            "GitHub annotated tag object SHA does not match its ref.",
        );
    }
    if (tagObject.tag !== tagName) {
        throw new Error(
            "GitHub annotated tag name does not match the release ref.",
        );
    }
    assertRecord(tagObject.object, "GitHub annotated tag target");
    if (tagObject.object.type !== GIT_OBJECT_TYPE_COMMIT) {
        throw new Error("Release tag must target a commit.");
    }
    const targetCommit = normalizeGitObjectSha(
        tagObject.object.sha,
        "signed tag target commit",
    );

    assertRecord(tagObject.verification, "GitHub tag verification");
    const verification = tagObject.verification;
    if (
        verification.verified !== true ||
        verification.reason !== GITHUB_VERIFICATION_REASON_VALID
    ) {
        throw new Error(
            `GitHub did not verify the release tag signature as valid (reason: ${JSON.stringify(verification.reason)}).`,
        );
    }
    if (
        typeof verification.signature !== "string" ||
        !verification.signature.trimStart().startsWith(PGP_SIGNATURE_BEGIN)
    ) {
        throw new Error("Release tag must carry a verified OpenPGP signature.");
    }
    assertSignedTagPayload(verification.payload, tagName, targetCommit);
    return targetCommit;
}

function assertSignedTagPayload(payload, tagName, targetCommit) {
    if (typeof payload !== "string") {
        throw new Error(
            "GitHub tag verification did not return a signed payload.",
        );
    }
    const payloadLines = new Set(payload.split(/\r?\n/));
    for (const expectedLine of [
        `object ${targetCommit}`,
        `type ${GIT_OBJECT_TYPE_COMMIT}`,
        `tag ${tagName}`,
    ]) {
        if (!payloadLines.has(expectedLine)) {
            throw new Error(
                "GitHub's verified tag payload does not match the release tag object.",
            );
        }
    }
}

async function requestGitHubJson(
    fetchImplementation,
    url,
    githubToken,
    description,
) {
    const response = await fetchImplementation(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${githubToken}`,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
    });
    if (!response?.ok) {
        throw new Error(
            `GitHub ${description} request failed with status ${response?.status ?? "unknown"}.`,
        );
    }
    try {
        return await response.json();
    } catch {
        throw new Error(`GitHub ${description} response was not valid JSON.`);
    }
}

function createGitHubApiUrl(apiBaseUrl, repository, relativePath) {
    return `${apiBaseUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/${relativePath}`;
}

function parseRepository(value) {
    const [owner, name, ...extraParts] = value.split("/");
    if (!owner || !name || extraParts.length > 0) {
        throw new Error(
            `${ENV_GITHUB_REPOSITORY} must use owner/repository form.`,
        );
    }
    return { owner, name };
}

function createGitEnvironment(environment) {
    const gitEnvironment = { ...environment };
    delete gitEnvironment[ENV_GITHUB_TOKEN];
    delete gitEnvironment[ENV_GH_TOKEN];
    return gitEnvironment;
}

async function runGit(args, options) {
    return await execFileAsync("git", args, {
        ...options,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
    });
}

function normalizeGitObjectSha(value, description) {
    const sha = String(value ?? "")
        .trim()
        .toLowerCase();
    if (!GIT_OBJECT_SHA_PATTERN.test(sha)) {
        throw new Error(`${description} is not a full Git object SHA.`);
    }
    return sha;
}

function assertRecord(value, description) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${description} is missing or malformed.`);
    }
}

function requireEnvironmentValue(environment, key) {
    return requireNonEmptyValue(
        environment[key],
        `environment variable ${key}`,
    );
}

function requireNonEmptyValue(value, description) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`Missing ${description}.`);
    }
    return normalized;
}

async function main() {
    const command = process.argv[2];
    if (command === COMMAND_VALIDATE) {
        const result = await validateReleaseAdmission();
        console.log(
            `Validated signed release tag ${result.tagName} at ${result.targetCommit}.`,
        );
        return;
    }
    if (command === COMMAND_METADATA) {
        const result = await writeReleaseMetadata(process.env);
        console.log(`Prepared release metadata for ${result.tagName}.`);
        return;
    }
    throw new Error(
        `Usage: node scripts/build/desktop-release-admission.mjs <${COMMAND_VALIDATE}|${COMMAND_METADATA}>`,
    );
}

// Redacts the workflow token or returns a fixed message when redaction is unsafe.
export function formatReleaseAdmissionFailure(error, environment) {
    try {
        const redactor = createSecretRedactor([
            environment[ENV_GITHUB_TOKEN],
            environment[ENV_GH_TOKEN],
        ]);
        return redactor.redact(
            error instanceof Error ? error.stack : String(error),
        );
    } catch {
        return "Desktop release admission failed before a safe output redactor could be created.";
    }
}

const isMainModule =
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
    try {
        await main();
    } catch (error) {
        console.error(formatReleaseAdmissionFailure(error, process.env));
        process.exitCode = 1;
    }
}
