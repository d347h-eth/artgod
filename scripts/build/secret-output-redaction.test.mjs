import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import {
    createRedactedOutputWriter,
    createSecretRedactor,
    runRedactedCommand,
    writeRedactedTextFile,
} from "./secret-output-redaction.mjs";

const secretSentinel = "signing-secret-sentinel-7F4C9A2E";
const derivedCredentialCases = [
    {
        name: "JSON authorization headers",
        value: JSON.stringify({
            Authorization: "Basic Zml4dHVyZTpwYXNzd29yZA==",
            "Proxy-Authorization": "AWS4-HMAC-SHA256 Credential=upload-session",
            status: "upload failed",
        }),
        expected: JSON.stringify({
            Authorization: "[REDACTED]",
            "Proxy-Authorization": "[REDACTED]",
            status: "upload failed",
        }),
    },
    {
        name: "URL user information",
        value: "https://upload-user:upload-password@upload.invalid/bundle.dmg",
        expected: "https://[REDACTED]@upload.invalid/bundle.dmg",
    },
    ...[
        "X-Amz-Credential",
        "X-Amz-Signature",
        "X-Amz-Security-Token",
        "X-Goog-Credential",
        "X-Goog-Signature",
        "AWSAccessKeyId",
        "Signature",
        "GoogleAccessId",
        "sig",
        "access_token",
        "token",
        "api_key",
        "api-key",
        "password",
        "secret",
    ].map((key) => ({
        name: `${key} URL query credential`,
        value: `https://upload.invalid/bundle.dmg?part=1&${key}=derived%2Bupload%2Fcredential%3D&retry=2`,
        expected: `https://upload.invalid/bundle.dmg?part=1&${key}=[REDACTED]&retry=2`,
    })),
];

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

for (const { name, value, expected } of derivedCredentialCases) {
    test(`redacts ${name} without configured secrets`, () => {
        const redactor = createSecretRedactor([]);
        assert.equal(redactor.redact(value), expected);

        for (let splitIndex = 1; splitIndex < value.length; splitIndex += 1) {
            const output = createMemoryOutput();
            const writer = createRedactedOutputWriter(output.target, redactor);
            writer.write(value.slice(0, splitIndex));
            writer.write(`${value.slice(splitIndex)}\n`);
            writer.end();
            assert.equal(output.read(), `${expected}\n`);
        }
    });
}

test("decodes split UTF-8 before matching a streamed secret", () => {
    const value = "release-🔑-pässphrase";
    const bytes = Buffer.from(`before ${value} after\n`, "utf8");
    const redactor = createSecretRedactor([value]);

    for (let splitIndex = 1; splitIndex < bytes.length; splitIndex += 1) {
        const output = createMemoryOutput();
        const writer = createRedactedOutputWriter(output.target, redactor);
        writer.write(bytes.subarray(0, splitIndex));
        writer.write(bytes.subarray(splitIndex));
        writer.end();
        assert.equal(output.read(), "before [REDACTED] after\n");
    }
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

test("rejects non-empty secrets that cannot be redacted safely", () => {
    assert.throws(
        () => createSecretRedactor(["abc"]),
        /non-empty secret shorter than 4 characters/,
    );
    assert.doesNotThrow(() => createSecretRedactor([undefined, ""]));
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
        await runRedactedCommand(process.execPath, ["-e", childScript], {
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

test("redacts generated credentials in child output and failure details", async () => {
    const stdout = createMemoryOutput();
    const stderr = createMemoryOutput();
    const value = derivedCredentialCases.map(({ value }) => value).join("\n");
    const expected = derivedCredentialCases
        .map(({ expected }) => expected)
        .join("\n");
    const childScript = [
        'const fs = require("node:fs")',
        "fs.writeSync(1, process.env.OUTPUT_FIXTURE)",
        "fs.writeSync(2, process.env.OUTPUT_FIXTURE)",
        "process.exitCode = 7",
    ].join(";");
    let commandError;
    try {
        await runRedactedCommand(process.execPath, ["-e", childScript], {
            env: { OUTPUT_FIXTURE: value },
            stream: true,
            stdoutTarget: stdout.target,
            stderrTarget: stderr.target,
        });
    } catch (error) {
        commandError = error;
    }

    assert.ok(commandError instanceof Error);
    assert.equal(stdout.read(), expected);
    assert.equal(stderr.read(), expected);
    assert.ok(commandError.message.endsWith(expected));
    for (const publicOutput of [
        commandError.stack,
        JSON.stringify(commandError),
        inspect(commandError, { showHidden: true }),
    ]) {
        assert.doesNotMatch(
            publicOutput,
            /Zml4dHVyZTpwYXNzd29yZA|upload-session|upload-password|derived%2Bupload/,
        );
    }
});

test("retains complete UTF-8 internally while redacting both child pipes", async () => {
    const value = "release-🔑-pässphrase";
    const stdout = createMemoryOutput();
    const stderr = createMemoryOutput();
    const childScript = [
        'const fs = require("node:fs")',
        "const bytes = Buffer.from(process.env.OUTPUT_FIXTURE)",
        "fs.writeSync(1, bytes.subarray(0, 9))",
        "fs.writeSync(2, bytes.subarray(0, 9))",
        "setTimeout(() => { fs.writeSync(1, bytes.subarray(9)); fs.writeSync(2, bytes.subarray(9)); }, 20)",
    ].join(";");
    const result = await runRedactedCommand(
        process.execPath,
        ["-e", childScript],
        {
            env: { OUTPUT_FIXTURE: value },
            redactor: createSecretRedactor([value]),
            stream: true,
            stdoutTarget: stdout.target,
            stderrTarget: stderr.target,
        },
    );

    assert.equal(result.stdout, value);
    assert.equal(result.stderr, value);
    assert.equal(stdout.read(), "[REDACTED]");
    assert.equal(stderr.read(), "[REDACTED]");
});

test("redacts secrets before writing diagnostic artifacts", async () => {
    const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "artgod-signing-redaction-"),
    );
    const diagnosticPath = path.join(temporaryDirectory, "diagnostic.log");
    const redactor = createSecretRedactor([secretSentinel]);

    try {
        await writeRedactedTextFile(
            diagnosticPath,
            [
                `diagnostic:${secretSentinel}`,
                ...derivedCredentialCases.map(({ value }) => value),
            ].join("\n"),
            redactor,
        );
        const diagnostic = await readFile(diagnosticPath, "utf8");
        assert.equal(
            diagnostic,
            [
                "diagnostic:[REDACTED]",
                ...derivedCredentialCases.map(({ expected }) => expected),
            ].join("\n"),
        );
        assert.doesNotMatch(diagnostic, new RegExp(secretSentinel));
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
});
