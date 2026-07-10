import assert from "node:assert/strict";
import test from "node:test";

import {
    GITHUB_REF_TYPE_TAG,
    NOTARY_STATUS_ACCEPTED,
    assertAcceptedNotaryLog,
    assertResumeContext,
    parseSubmissionId,
    readNotaryStatus,
} from "./macos-notarization.mjs";

const submissionId = "11111111-2222-4333-8444-555555555555";
const artifactName = "ArtGod_test_universal.dmg";
const artifactSha256 = "a".repeat(64);

test("parses the submission ID following the human-output marker", () => {
    const output = `
Conducting pre-submission checks...
Submission ID received
  id: ${submissionId}
Successfully uploaded file
`;

    assert.equal(parseSubmissionId(output), submissionId);
});

test("reads Apple's status contract", () => {
    assert.equal(
        readNotaryStatus({ status: NOTARY_STATUS_ACCEPTED }),
        NOTARY_STATUS_ACCEPTED,
    );
});

test("accepts a matching successful notarization log", () => {
    assert.doesNotThrow(() =>
        assertAcceptedNotaryLog(
            {
                jobId: submissionId,
                status: NOTARY_STATUS_ACCEPTED,
                archiveFilename: artifactName,
                sha256: artifactSha256,
                issues: null,
            },
            {
                submissionId,
                artifactName,
                sha256: artifactSha256,
            },
        ),
    );
});

test("rejects an Apple log for different DMG bytes", () => {
    assert.throws(
        () =>
            assertAcceptedNotaryLog(
                {
                    jobId: submissionId,
                    status: NOTARY_STATUS_ACCEPTED,
                    archiveFilename: artifactName,
                    sha256: "0".repeat(64),
                    issues: null,
                },
                {
                    submissionId,
                    artifactName,
                    sha256: artifactSha256,
                },
            ),
        /SHA-256 does not match/,
    );
});

test("requires resume runs to use the original tag, commit, and run", () => {
    const source = {
        repository: "owner/artgod",
        refName: "v0.0.1-pre-alpha.63",
        refType: GITHUB_REF_TYPE_TAG,
        sha: "abc123",
        runId: "123456",
    };

    const matchingContext = {
        repository: source.repository,
        refName: source.refName,
        refType: GITHUB_REF_TYPE_TAG,
        sha: source.sha,
        sourceRunId: source.runId,
    };

    assert.doesNotThrow(() => assertResumeContext({ source }, matchingContext));
    assert.throws(
        () =>
            assertResumeContext(
                { source },
                {
                    ...matchingContext,
                    refType: "branch",
                },
            ),
        /original release tag/,
    );
    assert.throws(
        () =>
            assertResumeContext(
                { source },
                { ...matchingContext, sourceRunId: "654321" },
            ),
        /source workflow run does not match/,
    );
    assert.throws(
        () =>
            assertResumeContext(
                { source },
                { ...matchingContext, sha: "def456" },
            ),
        /release commit does not match/,
    );
});
