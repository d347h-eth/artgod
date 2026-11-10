import assert from "node:assert/strict";
import test from "node:test";
import { assertExpectedOverlay, extractRun } from "./extract-run.mjs";

const info = () => ({
    format: "qcow2",
    "backing-filename-format": "qcow2",
    "backing-filename": "../immutable/guest.qcow2",
    "full-backing-filename": "/fixture/immutable/guest.qcow2",
    "format-specific": { data: { "dirty-flag": false } },
});

test("diagnostic admission allows only the expected immutable guest backing image", () => {
    assertExpectedOverlay(
        info(),
        "/fixture/immutable/guest.qcow2",
        "/fixture/run",
    );
    for (const patch of [
        { "backing-filename": "/unrelated/guest.qcow2" },
        { "full-backing-filename": "/unrelated/guest.qcow2" },
        { "backing-filename-format": "raw" },
        { format: "raw" },
    ])
        assert.throws(() =>
            assertExpectedOverlay(
                { ...info(), ...patch },
                "/fixture/immutable/guest.qcow2",
                "/fixture/run",
            ),
        );
});

test("incomplete, external-data and encrypted overlays cannot be silently extracted", () => {
    for (const data of [
        { "dirty-flag": true },
        { corrupt: true },
        { "data-file": "another-file" },
        { encrypted: true },
        { encrypt: { format: "luks" } },
    ])
        assert.throws(
            () =>
                assertExpectedOverlay(
                    { ...info(), "format-specific": { data } },
                    "/fixture/immutable/guest.qcow2",
                    "/fixture/run",
                ),
            /incomplete storage metadata/,
        );
});

test("diagnostics require an explicit mode and installed filesystem reader", async () => {
    await assert.rejects(extractRun({ mode: "running" }), /mode/);
    await assert.rejects(
        extractRun({ runDirectory: "unused" }),
        /explicit installed debugfs/,
    );
    await assert.rejects(
        extractRun({ runDirectory: "unused", debugfs: "debugfs" }),
        /explicit installed debugfs/,
    );
});
