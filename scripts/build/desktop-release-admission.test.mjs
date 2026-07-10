import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    formatReleaseAdmissionFailure,
    validateReleaseAdmission,
    writeReleaseMetadata,
} from "./desktop-release-admission.mjs";
import {
    classifyReleaseTag,
    RELEASE_TAG_REF_TYPE,
} from "./desktop-release-contract.mjs";
import { readCanonicalProjectVersion } from "./sync-version.mjs";

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const projectVersion = await readCanonicalProjectVersion(projectRoot);
const releaseTag = `v${projectVersion}`;
const testReleaseTag = `${releaseTag}-test.1`;
const targetCommit = "a".repeat(40);
const tagObjectSha = "b".repeat(40);
const githubToken = "github-token-sentinel-7F4C9A2E";

function createEnvironment(tagName = releaseTag) {
    return {
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_REF: `refs/tags/${tagName}`,
        GITHUB_REF_NAME: tagName,
        GITHUB_REF_TYPE: RELEASE_TAG_REF_TYPE,
        GITHUB_REPOSITORY: "owner/artgod",
        GITHUB_SHA: targetCommit,
        GITHUB_TOKEN: githubToken,
    };
}

function createTagResponses(overrides = {}) {
    return {
        reference: {
            ref: `refs/tags/${releaseTag}`,
            object: { type: "tag", sha: tagObjectSha },
            ...overrides.reference,
        },
        tagObject: {
            sha: tagObjectSha,
            tag: releaseTag,
            object: { type: "commit", sha: targetCommit },
            verification: {
                verified: true,
                reason: "valid",
                signature:
                    "-----BEGIN PGP SIGNATURE-----\nsynthetic\n-----END PGP SIGNATURE-----",
                payload: [
                    `object ${targetCommit}`,
                    "type commit",
                    `tag ${releaseTag}`,
                    "",
                    "Synthetic release tag",
                ].join("\n"),
            },
            ...overrides.tagObject,
        },
    };
}

function createAdmissionHarness(overrides = {}) {
    const responses = createTagResponses(overrides);
    const observations = { requests: [], gitCalls: [] };

    return {
        observations,
        async fetchImplementation(url, options) {
            observations.requests.push({ url, options });
            const body = url.includes("/git/ref/tags/")
                ? responses.reference
                : responses.tagObject;
            return {
                ok: true,
                status: 200,
                async json() {
                    return body;
                },
            };
        },
        async gitRunner(args, options) {
            observations.gitCalls.push({ args, options });
            assert.equal(options.env.GITHUB_TOKEN, undefined);
            if (args[0] === "rev-parse") {
                return { stdout: `${targetCommit}\n`, stderr: "" };
            }
            if (args[0] === "merge-base") {
                if (overrides.rejectMainAncestry) {
                    throw new Error("not an ancestor");
                }
                return { stdout: "", stderr: "" };
            }
            throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
        },
    };
}

test("classifies only exact release and numbered test tags", () => {
    assert.equal(
        classifyReleaseTag(releaseTag, projectVersion).isTestRelease,
        false,
    );
    assert.equal(
        classifyReleaseTag(testReleaseTag, projectVersion).isTestRelease,
        true,
    );
    assert.throws(
        () => classifyReleaseTag(`${releaseTag}-test.0`, projectVersion),
        /positive-integer/,
    );
    assert.throws(
        () => classifyReleaseTag("v9.9.9", projectVersion),
        /must be/,
    );
});

test("admits a GitHub-verified PGP tag for the checked-out main commit", async () => {
    const harness = createAdmissionHarness();
    const result = await validateReleaseAdmission({
        environment: createEnvironment(),
        projectRoot,
        fetchImplementation: harness.fetchImplementation,
        gitRunner: harness.gitRunner,
    });

    assert.equal(result.tagName, releaseTag);
    assert.equal(result.targetCommit, targetCommit);
    assert.equal(harness.observations.requests.length, 2);
    assert.equal(harness.observations.gitCalls.length, 2);
    for (const { options } of harness.observations.requests) {
        assert.equal(options.headers.Authorization, `Bearer ${githubToken}`);
    }
});

test("rejects lightweight and unverified release tags", async () => {
    const lightweightHarness = createAdmissionHarness({
        reference: { object: { type: "commit", sha: targetCommit } },
    });
    await assert.rejects(
        validateReleaseAdmission({
            environment: createEnvironment(),
            projectRoot,
            fetchImplementation: lightweightHarness.fetchImplementation,
            gitRunner: lightweightHarness.gitRunner,
        }),
        /annotated tag, not a lightweight tag/,
    );

    const unverifiedHarness = createAdmissionHarness({
        tagObject: {
            verification: {
                verified: false,
                reason: "unknown_key",
                signature: null,
                payload: null,
            },
        },
    });
    await assert.rejects(
        validateReleaseAdmission({
            environment: createEnvironment(),
            projectRoot,
            fetchImplementation: unverifiedHarness.fetchImplementation,
            gitRunner: unverifiedHarness.gitRunner,
        }),
        /did not verify.*unknown_key/,
    );
});

test("rejects mismatched versions and commits outside main", async () => {
    const versionHarness = createAdmissionHarness();
    await assert.rejects(
        validateReleaseAdmission({
            environment: createEnvironment("v9.9.9"),
            projectRoot,
            fetchImplementation: versionHarness.fetchImplementation,
            gitRunner: versionHarness.gitRunner,
        }),
        /must be/,
    );
    assert.equal(versionHarness.observations.requests.length, 0);

    const ancestryHarness = createAdmissionHarness({
        rejectMainAncestry: true,
    });
    await assert.rejects(
        validateReleaseAdmission({
            environment: createEnvironment(),
            projectRoot,
            fetchImplementation: ancestryHarness.fetchImplementation,
            gitRunner: ancestryHarness.gitRunner,
        }),
        /not an ancestor of refs\/remotes\/origin\/main/,
    );
});

test("does not include API response bodies in request failures", async () => {
    const secretResponseBody = "server-body-secret-sentinel";
    await assert.rejects(
        validateReleaseAdmission({
            environment: createEnvironment(),
            projectRoot,
            async fetchImplementation() {
                return {
                    ok: false,
                    status: 503,
                    async text() {
                        return secretResponseBody;
                    },
                };
            },
            gitRunner: async () => ({ stdout: targetCommit, stderr: "" }),
        }),
        (error) => {
            assert.doesNotMatch(error.message, new RegExp(secretResponseBody));
            assert.match(error.message, /status 503/);
            return true;
        },
    );
});

test("redacts workflow tokens from public admission failures", () => {
    const formatted = formatReleaseAdmissionFailure(
        new Error(`synthetic failure: ${githubToken}`),
        { GITHUB_TOKEN: githubToken },
    );
    assert.doesNotMatch(formatted, new RegExp(githubToken));
    assert.match(formatted, /\[REDACTED\]/);

    const unsafeShortToken = "abc";
    const fallback = formatReleaseAdmissionFailure(
        new Error(`synthetic failure: ${unsafeShortToken}`),
        { GITHUB_TOKEN: unsafeShortToken },
    );
    assert.doesNotMatch(fallback, new RegExp(unsafeShortToken));
    assert.equal(
        fallback,
        "Desktop release admission failed before a safe output redactor could be created.",
    );
});

test("writes centralized GitHub Release metadata for test tags", async () => {
    const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "artgod-release-metadata-test-"),
    );
    const outputPath = path.join(temporaryDirectory, "github-output.txt");

    try {
        const classification = await writeReleaseMetadata(
            {
                ...createEnvironment(testReleaseTag),
                GITHUB_OUTPUT: outputPath,
            },
            projectRoot,
        );
        assert.equal(classification.isTestRelease, true);
        assert.equal(
            await readFile(outputPath, "utf8"),
            "prerelease=true\nmake_latest=false\n",
        );
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
});
