import assert from "node:assert/strict";
import test from "node:test";

import {
    formatReleasePublicationFailure,
    publishStagedGitHubRelease,
} from "./github-release-publication.mjs";
import { ENV_DESKTOP_RELEASE_NOTES_PATH } from "./desktop-release-notes.mjs";

const releaseId = 352395900;
const releaseTag = "v0.0.1-pre-alpha.66-test.12";
const githubToken = "github-publication-token-sentinel-54D28B91";
const releaseApiUrl = `https://api.github.test/repos/owner/artgod/releases/${releaseId}`;
const releaseNotes = `- Easier collection setup.\n\n[Full changelog](https://github.com/owner/artgod/blob/${"a".repeat(40)}/CHANGELOG.md)\n`;

function createEnvironment(overrides = {}) {
    return {
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_REF_NAME: releaseTag,
        GITHUB_REPOSITORY: "owner/artgod",
        GITHUB_TOKEN: githubToken,
        STAGED_GITHUB_RELEASE_ID: String(releaseId),
        RELEASE_PRERELEASE: "true",
        RELEASE_MAKE_LATEST: "false",
        [ENV_DESKTOP_RELEASE_NOTES_PATH]: "tmp/github-release-notes.md",
        ...overrides,
    };
}

function createRelease(overrides = {}) {
    return {
        id: releaseId,
        tag_name: releaseTag,
        draft: true,
        prerelease: true,
        immutable: false,
        body: releaseNotes,
        assets: [
            { id: 1, name: "ArtGod.AppImage", state: "uploaded" },
            { id: 2, name: "SHA256SUMS.txt", state: "uploaded" },
        ],
        ...overrides,
    };
}

function createPublicationHarness(overrides = {}) {
    const stagedRelease = createRelease(overrides.stagedRelease);
    const publishedRelease = createRelease({
        ...stagedRelease,
        draft: false,
        immutable: true,
        ...overrides.publishedRelease,
    });
    const requests = [];

    return {
        requests,
        async readFileImplementation() {
            return overrides.releaseNotes ?? releaseNotes;
        },
        async fetchImplementation(url, options) {
            requests.push({ url, options });
            const response =
                options.method === "PATCH" ? publishedRelease : stagedRelease;
            return {
                ok: overrides.responseOk ?? true,
                status: overrides.responseStatus ?? 200,
                async json() {
                    return response;
                },
            };
        },
    };
}

test("publishes the exact staged prerelease by numeric release ID", async () => {
    const harness = createPublicationHarness();
    const result = await publishStagedGitHubRelease({
        environment: createEnvironment(),
        fetchImplementation: harness.fetchImplementation,
        readFileImplementation: harness.readFileImplementation,
    });

    assert.deepEqual(result, {
        releaseId,
        tagName: releaseTag,
        prerelease: true,
        assetCount: 2,
    });
    assert.equal(harness.requests.length, 2);
    assert.deepEqual(
        harness.requests.map(({ url }) => url),
        [releaseApiUrl, releaseApiUrl],
    );

    const [validationRequest, publicationRequest] = harness.requests;
    assert.equal(validationRequest.options.method, "GET");
    assert.equal(
        validationRequest.options.headers.Authorization,
        `Bearer ${githubToken}`,
    );
    assert.equal(publicationRequest.options.method, "PATCH");
    assert.equal(
        publicationRequest.options.headers["Content-Type"],
        "application/json",
    );
    assert.deepEqual(JSON.parse(publicationRequest.options.body), {
        draft: false,
        prerelease: true,
        make_latest: "false",
    });
    assert.doesNotMatch(publicationRequest.options.body, /tag_name/);
});

test("publishes a stable staged release as Latest", async () => {
    const stableTag = "v0.0.1-pre-alpha.66";
    const harness = createPublicationHarness({
        stagedRelease: { tag_name: stableTag, prerelease: false },
        publishedRelease: { tag_name: stableTag, prerelease: false },
    });

    await publishStagedGitHubRelease({
        environment: createEnvironment({
            GITHUB_REF_NAME: stableTag,
            RELEASE_PRERELEASE: "false",
            RELEASE_MAKE_LATEST: "true",
        }),
        fetchImplementation: harness.fetchImplementation,
        readFileImplementation: harness.readFileImplementation,
    });

    assert.deepEqual(JSON.parse(harness.requests[1].options.body), {
        draft: false,
        prerelease: false,
        make_latest: "true",
    });
});

test("rejects a mismatched or incomplete staged release before publication", async () => {
    const invalidDrafts = [
        [{ id: releaseId + 1 }, /different numeric release ID/],
        [{ tag_name: `${releaseTag}-wrong` }, /tag does not match/],
        [{ prerelease: false }, /channel does not match/],
        [{ draft: false }, /is not a draft/],
        [{ body: null }, /body does not match/],
        [{ body: "" }, /body does not match/],
        [{ body: "Old or verbose release notes." }, /body does not match/],
        [{ assets: [] }, /has no uploaded assets/],
        [
            { assets: [{ id: 1, name: "artifact", state: "new" }] },
            /incomplete asset/,
        ],
    ];

    for (const [stagedRelease, expectedError] of invalidDrafts) {
        const harness = createPublicationHarness({ stagedRelease });
        await assert.rejects(
            publishStagedGitHubRelease({
                environment: createEnvironment(),
                fetchImplementation: harness.fetchImplementation,
                readFileImplementation: harness.readFileImplementation,
            }),
            expectedError,
        );
        assert.equal(harness.requests.length, 1);
    }
});

test("rejects invalid publication metadata before calling GitHub", async () => {
    const invalidEnvironments = [
        [{ STAGED_GITHUB_RELEASE_ID: "0" }, /positive integer release ID/],
        [{ RELEASE_PRERELEASE: "yes" }, /must be true or false/],
        [{ RELEASE_MAKE_LATEST: "legacy" }, /must be true or false/],
        [
            { [ENV_DESKTOP_RELEASE_NOTES_PATH]: "" },
            /Missing environment variable/,
        ],
        [
            { RELEASE_MAKE_LATEST: "true" },
            /pre-release cannot be marked Latest/,
        ],
        [
            {
                RELEASE_PRERELEASE: "false",
                RELEASE_MAKE_LATEST: "false",
            },
            /stable GitHub release must be marked Latest/,
        ],
    ];

    for (const [environmentOverride, expectedError] of invalidEnvironments) {
        let requestCount = 0;
        await assert.rejects(
            publishStagedGitHubRelease({
                environment: createEnvironment(environmentOverride),
                async fetchImplementation() {
                    requestCount += 1;
                },
            }),
            expectedError,
        );
        assert.equal(requestCount, 0);
    }
});

test("rejects missing or empty generated notes before calling GitHub", async () => {
    for (const failure of ["missing", "empty"]) {
        const harness = createPublicationHarness();
        await assert.rejects(
            publishStagedGitHubRelease({
                environment: createEnvironment(),
                fetchImplementation: harness.fetchImplementation,
                async readFileImplementation() {
                    if (failure === "missing") {
                        throw new Error("ENOENT: notes file missing");
                    }
                    return " \n";
                },
            }),
            failure === "missing" ? /ENOENT/ : /release notes are empty/,
        );
        assert.equal(harness.requests.length, 0);
    }
});

test("requires GitHub to report an immutable release with preserved assets and notes", async () => {
    const mutableHarness = createPublicationHarness({
        publishedRelease: { immutable: false },
    });
    await assert.rejects(
        publishStagedGitHubRelease({
            environment: createEnvironment(),
            fetchImplementation: mutableHarness.fetchImplementation,
            readFileImplementation: mutableHarness.readFileImplementation,
        }),
        /not immutable/,
    );

    const missingAssetHarness = createPublicationHarness({
        publishedRelease: {
            assets: [{ id: 1, name: "ArtGod.AppImage", state: "uploaded" }],
        },
    });
    await assert.rejects(
        publishStagedGitHubRelease({
            environment: createEnvironment(),
            fetchImplementation: missingAssetHarness.fetchImplementation,
            readFileImplementation: missingAssetHarness.readFileImplementation,
        }),
        /assets differ/,
    );

    const changedNotesHarness = createPublicationHarness({
        publishedRelease: { body: "Unexpected release notes." },
    });
    await assert.rejects(
        publishStagedGitHubRelease({
            environment: createEnvironment(),
            fetchImplementation: changedNotesHarness.fetchImplementation,
            readFileImplementation: changedNotesHarness.readFileImplementation,
        }),
        /body does not match/,
    );
});

test("does not include API response bodies in publication failures", async () => {
    const responseBodySecret = "publication-response-secret-sentinel";
    await assert.rejects(
        publishStagedGitHubRelease({
            environment: createEnvironment(),
            readFileImplementation: async () => releaseNotes,
            async fetchImplementation() {
                return {
                    ok: false,
                    status: 503,
                    async text() {
                        return responseBodySecret;
                    },
                };
            },
        }),
        (error) => {
            assert.doesNotMatch(error.message, new RegExp(responseBodySecret));
            assert.match(error.message, /status 503/);
            return true;
        },
    );
});

test("redacts workflow tokens from public publication failures", () => {
    const formatted = formatReleasePublicationFailure(
        new Error(`synthetic failure: ${githubToken}`),
        { GITHUB_TOKEN: githubToken },
    );
    assert.doesNotMatch(formatted, new RegExp(githubToken));
    assert.match(formatted, /\[REDACTED\]/);

    const unsafeShortToken = "abc";
    const fallback = formatReleasePublicationFailure(
        new Error(`synthetic failure: ${unsafeShortToken}`),
        { GITHUB_TOKEN: unsafeShortToken },
    );
    assert.doesNotMatch(fallback, new RegExp(unsafeShortToken));
    assert.equal(
        fallback,
        "GitHub release publication failed before a safe output redactor could be created.",
    );
});
