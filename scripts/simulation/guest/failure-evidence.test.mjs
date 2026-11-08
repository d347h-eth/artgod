import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createArtifactRunDirectory, hashFile } from "../artifacts.mjs";
import { readRunEvidence } from "../run-evidence.mjs";
import {
    DATA_PLANE_CHECK as CHECK,
    QUALIFICATION_PROTOCOL_PREFIX,
    QUALIFICATION_PROTOCOL_VERSION,
    QUALIFICATION_EVENT,
    QUALIFICATION_STATUS,
    SIMULATION_EVIDENCE_PREFIX,
    SIMULATION_EVIDENCE_EVENT,
} from "../qualification-protocol.mjs";
import { formatFailureEvidence } from "./failure-evidence.mjs";

const expected = [
    CHECK.RuntimeEntrypoints,
    CHECK.ChainAcquisition,
    CHECK.SafeRefusal,
];
function failure() {
    return Object.assign(new Error("Retained fact disappeared"), {
        simulation: {
            checks: {
                [CHECK.RuntimeEntrypoints]: true,
                [CHECK.SourceIngestion]: true,
                [CHECK.OrderValidation]: true,
                [CHECK.SafeRefusal]: false,
            },
            coverage: [{ check: CHECK.SourceIngestion, status: "passed" }],
            failedProperty: "retained-history",
            checkpoints: [{ name: "initial" }],
        },
    });
}

test("declared failure checks replace intermediate scopes while preserving reached-state coverage and diagnostics", () => {
    const error = failure();
    const evidence = formatFailureEvidence(error, expected);
    assert.deepEqual(Object.keys(evidence.checks), expected);
    assert.deepEqual(evidence.coverage, [
        { check: CHECK.RuntimeEntrypoints, status: "passed" },
        { check: CHECK.ChainAcquisition, status: "unreached" },
        { check: CHECK.SafeRefusal, status: "failed" },
    ]);
    assert.equal(evidence.failedProperty, "retained-history");
    assert.deepEqual(evidence.checkpoints, error.simulation.checkpoints);
    assert.equal(error.simulation.checks[CHECK.SourceIngestion], true);
});

test("a narrow failed journey with extra intermediate observations satisfies the actual host wire parser", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const directory = await createArtifactRunDirectory(
        path.join(root, "tmp/failure-evidence-tests"),
        "fixture-",
    );
    const evidence = formatFailureEvidence(failure(), expected);
    const serial = path.join(directory, "record-serial.log");
    const completion = {
        version: QUALIFICATION_PROTOCOL_VERSION,
        qualificationId: "synthetic-failure-wire-guard",
        event: QUALIFICATION_EVENT.Complete,
        status: QUALIFICATION_STATUS.Failed,
        checks: evidence.checks,
    };
    await writeFile(
        serial,
        `${SIMULATION_EVIDENCE_PREFIX}${JSON.stringify({ [SIMULATION_EVIDENCE_EVENT.Failure]: evidence })}\n${QUALIFICATION_PROTOCOL_PREFIX}${JSON.stringify(completion)}\n`,
    );
    await writeFile(
        path.join(directory, "report.json"),
        JSON.stringify({
            engineReplayStatus: "passed",
            propertyStatus: QUALIFICATION_STATUS.Failed,
            guestReportedChecks: evidence.checks,
            serialSha256: await hashFile(serial),
        }),
    );
    await writeFile(
        path.join(directory, "input-manifest.json"),
        JSON.stringify({ expectedChecks: expected }),
    );
    const parsed = await readRunEvidence(directory);
    assert.deepEqual(parsed.evidence.checks, evidence.checks);
    assert.deepEqual(parsed.coverage, evidence.coverage);
});
