import assert from "node:assert/strict";
import { writeFile, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createArtifactRunDirectory, hashFile } from "./artifacts.mjs";
import {
    readRunEvidence,
    captureArtifactJson,
    readGuestEvidence,
} from "./run-evidence.mjs";
import {
    SIMULATION_EVIDENCE_EVENT as EVENT,
    SIMULATION_EVIDENCE_PREFIX as PREFIX,
} from "./qualification-protocol.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("admitted JSON facts and byte pins share one capture, including original whitespace", async () => {
    const directory = await createArtifactRunDirectory(
        path.join(root, "tmp/readiness-tests"),
        "json-capture-",
    );
    const filename = path.join(directory, "input.json"),
        bytes = Buffer.from(' \n {"value":"original"} \n');
    await writeFile(filename, bytes);
    const captured = await captureArtifactJson(filename);
    assert.deepEqual(captured.value, { value: "original" });
    assert.deepEqual(captured.bytes, bytes);
    assert.equal(captured.pin.sizeBytes, bytes.length);
    assert.equal(captured.pin.sha256, await hashFile(filename));
});

test("a same-size write between JSON capture and disk pinning cannot bind old parsed facts to new bytes", async () => {
    const directory = await createArtifactRunDirectory(
        path.join(root, "tmp/readiness-tests"),
        "json-race-",
    );
    const filename = path.join(directory, "input.json"),
        old = Buffer.from('{"value":"old"}'),
        changed = Buffer.from('{"value":"new"}');
    await writeFile(filename, old);
    await assert.rejects(
        captureArtifactJson(filename, 1024, {
            readStream: async function* (file) {
                yield await readFile(file);
                await writeFile(file, changed);
            },
        }),
        /changed during byte capture/,
    );
    assert.deepEqual(await readFile(filename), changed);
    await assert.rejects(captureArtifactJson(filename, 2), /bounded/);
});
async function readiness(frames) {
    const directory = await createArtifactRunDirectory(
        path.join(root, "tmp/readiness-tests"),
        "fixture-",
    );
    await writeFile(
        path.join(directory, "record-serial.log"),
        frames.map((frame) => `${PREFIX}${JSON.stringify(frame)}\n`).join(""),
    );
    await writeFile(
        path.join(directory, "report.json"),
        JSON.stringify({
            engineReplayStatus: "failed",
            propertyStatus: "unqualified",
            serialSha256: await hashFile(
                path.join(directory, "record-serial.log"),
            ),
        }),
    );
    return directory;
}

test("actual readiness observations retain each process and subsequent restart generation", async () => {
    const frames = [
        { [EVENT.ProcessReady]: { id: "offchain", generation: 0, pid: 123 } },
        { [EVENT.ProcessReady]: { id: "backend", generation: 0, pid: 124 } },
        { [EVENT.ProcessReady]: { id: "offchain", generation: 1, pid: 125 } },
    ];
    const evidence = await readRunEvidence(await readiness(frames));
    assert.deepEqual(
        evidence.processReady,
        frames.map((frame) => frame[EVENT.ProcessReady]),
    );
    assert.equal(evidence.report.engineReplayStatus, "failed");
});

test("duplicate, skipped and malformed readiness frames cannot become claimed observations", async () => {
    for (const frames of [
        [
            { id: "offchain", generation: 0, pid: 123 },
            { id: "offchain", generation: 0, pid: 123 },
        ],
        [{ id: "offchain", generation: 2, pid: 123 }],
        [{ id: "offchain", generation: 0, pid: 1 }],
        [{ id: "offchain", generation: 0, pid: 123, invented: true }],
    ])
        await assert.rejects(
            readRunEvidence(
                await readiness(
                    frames.map((frame) => ({ [EVENT.ProcessReady]: frame })),
                ),
            ),
            /invalid identity or generation/,
        );
    await assert.rejects(
        readRunEvidence(await readiness([{ unknownObservation: {} }])),
        /unambiguous/,
    );
    await assert.rejects(
        readRunEvidence(
            await readiness([
                { [EVENT.Result]: null },
                { [EVENT.Result]: { checks: {}, evidence: { inert: true } } },
            ]),
        ),
        /unambiguous/,
    );
});

test("the public guest transport reader rejects nonregular artifacts before its first hash stream", async () => {
    const directory = await createArtifactRunDirectory(
        path.join(root, "tmp/readiness-tests"),
        "transport-bound-",
    );
    await assert.rejects(
        readGuestEvidence(directory),
        /bounded regular artifact/,
    );
    const filename = path.join(directory, "ordinary.log"),
        link = path.join(directory, "link.log");
    await writeFile(filename, "inert incomplete output");
    await symlink(filename, link);
    await assert.rejects(readGuestEvidence(link), /bounded regular artifact/);
});
