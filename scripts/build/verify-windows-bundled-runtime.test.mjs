import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hashExpectedNsisShell } from "./verify-windows-bundled-runtime.mjs";

// Deliberately assert the upstream wire serialization, including its first-match rule.
const unknown = "__TAURI_BUNDLE_TYPE_VAR_UNK";
const nsis = "__TAURI_BUNDLE_TYPE_VAR_NSS";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("NSIS shell verification permits exactly the pinned bundler marker change across stream boundaries", async () => {
    const original = Buffer.from(
        `PE prefix ${unknown} unchanged body ${unknown} PE suffix`,
    );
    const installed = Buffer.from(
        `PE prefix ${nsis} unchanged body ${unknown} PE suffix`,
    );
    for (let chunkSize = 1; chunkSize <= original.length; chunkSize++) {
        const chunks = [];
        for (let offset = 0; offset < original.length; offset += chunkSize) {
            chunks.push(original.subarray(offset, offset + chunkSize));
        }
        assert.equal(await hashExpectedNsisShell(chunks), digest(installed));
    }
    for (const changed of [
        Buffer.from(
            installed.toString().replace("unchanged body", "malicious body"),
        ),
        Buffer.from(installed.toString().replace(unknown, nsis)),
        Buffer.concat([installed, Buffer.from("extra bytes")]),
    ])
        assert.notEqual(
            await hashExpectedNsisShell([original]),
            digest(changed),
        );
});

test("an absent or already patched Cargo marker fails closed", async () => {
    for (const bytes of [
        Buffer.alloc(0),
        Buffer.from("PE without marker"),
        Buffer.from(nsis),
    ]) {
        await assert.rejects(
            hashExpectedNsisShell([bytes]),
            /lacks the reviewed Tauri/,
        );
    }
});
