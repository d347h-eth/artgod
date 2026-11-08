import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createArtifactRunDirectory, hashFile } from "./artifacts.mjs";
import { readRunEvidence } from "./run-evidence.mjs";
import {
    SIMULATION_EVIDENCE_EVENT as EVENT,
    SIMULATION_EVIDENCE_PREFIX as PREFIX,
} from "./qualification-protocol.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
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
});
