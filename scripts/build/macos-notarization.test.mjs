import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import {
    NOTARY_STATUS_ACCEPTED,
    NOTARY_OPTION_ISSUER,
    NOTARY_OPTION_KEY,
    NOTARY_OPTION_KEY_ID,
    assertAcceptedNotaryLog,
    assertResumeContext,
    createNotarySecretRedactor,
    createNotarySession,
    parseSubmissionId,
    readNotaryStatus,
    runCommand as runNotaryCommand,
} from "./macos-notarization.mjs";
import { RELEASE_TAG_REF_TYPE } from "./desktop-release-contract.mjs";

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
        refType: RELEASE_TAG_REF_TYPE,
        sha: "abc123",
        runId: "123456",
    };

    const matchingContext = {
        repository: source.repository,
        refName: source.refName,
        refType: RELEASE_TAG_REF_TYPE,
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

test("refuses authenticated notarytool commands without a redactor", async () => {
    await assert.rejects(
        runNotaryCommand(
            "xcrun",
            [
                "notarytool",
                "info",
                submissionId,
                NOTARY_OPTION_KEY,
                "/temporary/key.p8",
                NOTARY_OPTION_KEY_ID,
                "APIKEY1234",
                NOTARY_OPTION_ISSUER,
                "11111111-2222-4333-8444-555555555555",
            ],
            { stream: true },
        ),
        /without a populated output redactor/,
    );
});

test("redacts private-key payload fragments from notarization output", async () => {
    const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "artgod-notary-private-key-"),
    );
    const privateKeyPath = path.join(temporaryDirectory, "notary-key.p8");
    const privateKeyPayload = "AbCDef0123456789+/".repeat(8);
    const privateKey = [
        "-----BEGIN PRIVATE KEY-----",
        privateKeyPayload,
        "-----END PRIVATE KEY-----",
        "",
    ].join("\n");

    try {
        await writeFile(privateKeyPath, privateKey, { mode: 0o600 });
        const redactor = await createNotarySecretRedactor(
            {
                APPLE_API_KEY_PATH: privateKeyPath,
                APPLE_API_KEY_ID: "APIKEY1234",
                APPLE_API_ISSUER: "11111111-2222-4333-8444-555555555555",
            },
            true,
        );
        const privateKeyFragment = privateKeyPayload.slice(7, 19);
        const output = redactor.redact(
            `key-fragment:${privateKeyFragment};path:${privateKeyPath}`,
        );

        assert.equal(output, "key-fragment:[REDACTED];path:[REDACTED]");
        assert.doesNotMatch(output, new RegExp(privateKeyFragment));
        assert.doesNotMatch(
            inspect(redactor, { showHidden: true }),
            new RegExp(privateKeyPayload),
        );
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
});

test("keeps a base64 API key command-scoped and strips child environments", async () => {
    const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "artgod-notary-session-test-"),
    );
    const privateKeyPayload = "AbCDef0123456789+/".repeat(8);
    const privateKey = [
        "-----BEGIN PRIVATE KEY-----",
        privateKeyPayload,
        "-----END PRIVATE KEY-----",
        "",
    ].join("\n");
    const encodedPrivateKey = Buffer.from(privateKey, "utf8").toString(
        "base64",
    );
    const environment = {
        APPLE_API_KEY_P8_B64: encodedPrivateKey,
        APPLE_API_KEY_ID: "APIKEY1234",
        APPLE_API_ISSUER: "11111111-2222-4333-8444-555555555555",
    };
    let session;

    try {
        session = await createNotarySession(environment, {
            temporaryRoot: temporaryDirectory,
        });
        assert.equal(session.managedKey, true);
        assert.equal((await stat(session.keyPath)).mode & 0o777, 0o600);
        assert.equal(await readFile(session.keyPath, "utf8"), privateKey);
        assert.equal(
            session.redactor.redact(
                `${encodedPrivateKey}:${privateKeyPayload.slice(7, 19)}:${session.keyPath}`,
            ),
            "[REDACTED]:[REDACTED]:[REDACTED]",
        );

        const childScript = [
            'const fs = require("node:fs")',
            'const names = ["APPLE_API_KEY_PATH", "APPLE_API_KEY_P8_B64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]',
            "fs.writeSync(1, JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))))",
        ].join(";");
        const childResult = await runNotaryCommand(
            process.execPath,
            ["-e", childScript],
            {
                environment: {
                    ...environment,
                    APPLE_API_KEY_PATH: session.keyPath,
                },
                redactor: session.redactor,
            },
        );
        assert.deepEqual(JSON.parse(childResult.stdout), {
            APPLE_API_KEY_PATH: null,
            APPLE_API_KEY_P8_B64: null,
            APPLE_API_KEY_ID: null,
            APPLE_API_ISSUER: null,
        });

        const keyPath = session.keyPath;
        await session.close();
        await assert.rejects(stat(keyPath), { code: "ENOENT" });
        session = null;
    } finally {
        await session?.close();
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
});

test("keeps temporary signing credentials masked and job-local", async () => {
    const releaseWorkflow = await readFile(
        new URL("../../.github/workflows/tauri-release.yml", import.meta.url),
        "utf8",
    );

    assert.match(releaseWorkflow, /echo "::add-mask::\$KEYCHAIN_PASSWORD"/);
    assert.doesNotMatch(releaseWorkflow, /APPLE_KEYCHAIN_PASSWORD=/);
    assert.match(releaseWorkflow, /umask 077/);
    assert.match(releaseWorkflow, /chmod 600 "\$CERT_PATH"/);
    assert.match(releaseWorkflow, /chmod 600 "\$KEYCHAIN_PATH"/);
    assert.match(releaseWorkflow, /rm -f "\$CERT_PATH"/);
    assert.match(releaseWorkflow, /Remove temporary macOS signing credentials/);
    assert.doesNotMatch(releaseWorkflow, /APPLE_API_KEY_PATH=/);
    assert.doesNotMatch(releaseWorkflow, /Prepare macOS notarization API key/);
});
