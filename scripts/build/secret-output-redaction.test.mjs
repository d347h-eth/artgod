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

test("redacts secrets before writing diagnostic artifacts", async () => {
    const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "artgod-signing-redaction-"),
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
