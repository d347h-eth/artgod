import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import {
    GITHUB_REF_TYPE_TAG,
    NOTARY_STATUS_ACCEPTED,
    NOTARY_OPTION_ISSUER,
    NOTARY_OPTION_KEY,
    NOTARY_OPTION_KEY_ID,
    assertAcceptedNotaryLog,
    assertResumeContext,
    createNotarySecretRedactor,
    createRedactedOutputWriter,
    createSecretRedactor,
    parseSubmissionId,
    readNotaryStatus,
    runCommand,
    writeRedactedTextFile,
} from "./macos-notarization.mjs";

const submissionId = "11111111-2222-4333-8444-555555555555";
const artifactName = "ArtGod_test_universal.dmg";
const artifactSha256 = "a".repeat(64);
const secretSentinel = "notary-secret-sentinel-7F4C9A2E";

function createMemoryOutput() {
    let value = "";
    return {
        target: {
            write(chunk) {
                value += chunk.toString();
            },
        },
        read: () => value,
    };
}

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

test("redacts secrets split across streamed output chunks", () => {
    const redactor = createSecretRedactor([secretSentinel]);
    for (
        let splitIndex = 1;
        splitIndex < secretSentinel.length;
        splitIndex += 1
    ) {
        const output = createMemoryOutput();
        const writer = createRedactedOutputWriter(output.target, redactor);

        writer.write(`before ${secretSentinel.slice(0, splitIndex)}`);
        assert.equal(output.read(), "");
        writer.write(`${secretSentinel.slice(splitIndex)} after`);
        writer.end();

        assert.equal(output.read(), "before [REDACTED] after");
        assert.doesNotMatch(output.read(), new RegExp(secretSentinel));
    }
});

test("redacts a secret prefix when a child stream closes early", () => {
    const redactor = createSecretRedactor([secretSentinel]);
    const output = createMemoryOutput();
    const writer = createRedactedOutputWriter(output.target, redactor);

    writer.write(secretSentinel.slice(0, 16));
    writer.end();

    assert.equal(output.read(), "[REDACTED]");
});

test("redacts derived authorization credentials before streaming", () => {
    const redactor = createSecretRedactor([]);
    const output = createMemoryOutput();
    const writer = createRedactedOutputWriter(output.target, redactor);
    const derivedJwt =
        "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJub3Rhcnl0b29sIn0.signatureSegment1234";
    const splitIndex = Math.floor(derivedJwt.length / 2);

    writer.write(`jwt:${derivedJwt.slice(0, splitIndex)}`);
    writer.write(
        `${derivedJwt.slice(splitIndex)}\nAuthorization: Bearer derived-access-token-123456\n`,
    );
    writer.end();

    assert.equal(output.read(), "jwt:[REDACTED]\nAuthorization: [REDACTED]\n");
    assert.doesNotMatch(output.read(), /derived-access-token|eyJhbGci/);
});

test("redacts serialized secret variants", () => {
    const redactor = createSecretRedactor([secretSentinel]);
    const encodedSecret = encodeURIComponent(secretSentinel);
    const base64Secret = Buffer.from(secretSentinel, "utf8").toString("base64");
    const output = redactor.redact(
        `${secretSentinel}\n${encodedSecret}\n${base64Secret}`,
    );

    assert.equal(output, "[REDACTED]\n[REDACTED]\n[REDACTED]");
    assert.doesNotMatch(output, new RegExp(secretSentinel));
    assert.doesNotMatch(
        inspect(redactor, { showHidden: true }),
        new RegExp(secretSentinel),
    );
});

test("redacts child stdout, stderr, and failed-command errors before emission", async () => {
    const redactor = createSecretRedactor([secretSentinel]);
    const stdout = createMemoryOutput();
    const stderr = createMemoryOutput();
    const childScript = [
        'const fs = require("node:fs")',
        `fs.writeSync(1, "stdout:${secretSentinel}\\n")`,
        `fs.writeSync(2, "stderr:${secretSentinel}\\n")`,
        "process.exitCode = 7",
    ].join(";");

    let commandError;
    try {
        await runCommand(process.execPath, ["-e", childScript], {
            stream: true,
            redactor,
            stdoutTarget: stdout.target,
            stderrTarget: stderr.target,
        });
    } catch (error) {
        commandError = error;
    }

    assert.ok(commandError instanceof Error);
    for (const publicOutput of [
        stdout.read(),
        stderr.read(),
        commandError.message,
        commandError.stack,
        JSON.stringify(commandError),
        inspect(commandError, { showHidden: true }),
    ]) {
        assert.doesNotMatch(publicOutput, new RegExp(secretSentinel));
    }
    assert.match(stdout.read(), /stdout:\[REDACTED\]/);
    assert.match(stderr.read(), /stderr:\[REDACTED\]/);
    assert.match(commandError.message, /\[REDACTED\]/);
});

test("refuses authenticated notarytool commands without a redactor", async () => {
    await assert.rejects(
        runCommand(
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

test("redacts secrets before writing diagnostic artifacts", async () => {
    const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "artgod-notary-redaction-"),
    );
    const diagnosticPath = path.join(temporaryDirectory, "diagnostic.log");
    const redactor = createSecretRedactor([secretSentinel]);

    try {
        await writeRedactedTextFile(
            diagnosticPath,
            `diagnostic:${secretSentinel}`,
            redactor,
        );
        const diagnostic = await readFile(diagnosticPath, "utf8");
        assert.equal(diagnostic, "diagnostic:[REDACTED]");
        assert.doesNotMatch(diagnostic, new RegExp(secretSentinel));
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
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

test("keeps temporary signing credentials masked and job-local", async () => {
    const releaseWorkflow = await readFile(
        new URL("../../.github/workflows/tauri-release.yml", import.meta.url),
        "utf8",
    );

    assert.match(releaseWorkflow, /echo "::add-mask::\$KEYCHAIN_PASSWORD"/);
    assert.doesNotMatch(releaseWorkflow, /APPLE_KEYCHAIN_PASSWORD=/);
    assert.match(releaseWorkflow, /umask 077/);
    assert.match(releaseWorkflow, /chmod 600 "\$CERT_PATH"/);
    assert.match(releaseWorkflow, /chmod 600 "\$KEY_PATH"/);
    assert.match(releaseWorkflow, /chmod 600 "\$KEYCHAIN_PATH"/);
    assert.match(releaseWorkflow, /Remove temporary macOS credentials/);
    assert.match(releaseWorkflow, /Remove temporary macOS notarization key/);
});
