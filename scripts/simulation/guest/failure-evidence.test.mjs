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
import {
    formatFailureEvidence,
    recordDataPlaneFailureChecks,
} from "./failure-evidence.mjs";
import {
    STALE_RESULT_PROPERTY,
    STALE_RESULT_CUT_UNREACHED_CODE,
} from "./stale-result-cut.mjs";

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

test("native liveness failure fails runtime execution while the stale-result oracle remains unreached", () => {
    const selected = [CHECK.RuntimeEntrypoints, CHECK.StaleResultSafetyCut];
    const checks = {
        [CHECK.RuntimeEntrypoints]: true,
        [CHECK.StaleResultSafetyCut]: false,
    };
    const cause = new Error("Native exit observation");
    const error = Object.assign(
        new Error("Production domain exited (SIGSEGV)", { cause }),
        { property: STALE_RESULT_PROPERTY.Runtime },
    );
    const failedCheck = recordDataPlaneFailureChecks(
        error,
        checks,
        CHECK.StaleResultSafetyCut,
        selected,
    );
    assert.equal(failedCheck, CHECK.RuntimeEntrypoints);
    assert.equal(error.cause, cause);
    error.simulation = { checks, failedCheck };
    const result = formatFailureEvidence(error, selected);
    assert.equal(result.error, "Production domain exited (SIGSEGV)");
    assert.deepEqual(result.coverage, [
        { check: CHECK.RuntimeEntrypoints, status: "failed" },
        { check: CHECK.StaleResultSafetyCut, status: "unreached" },
    ]);
});

test("ordinary stale mutation assertions stay failed even alongside native diagnostic observations", () => {
    const selected = [CHECK.RuntimeEntrypoints, CHECK.StaleResultSafetyCut];
    const checks = {
        [CHECK.RuntimeEntrypoints]: true,
        [CHECK.StaleResultSafetyCut]: false,
    };
    const error = Object.assign(new Error("Old proof was applied"), {
        property: STALE_RESULT_PROPERTY.Projection,
        simulation: { processStates: [{ signalCode: "SIGSEGV" }] },
    });
    assert.equal(
        recordDataPlaneFailureChecks(
            error,
            checks,
            CHECK.StaleResultSafetyCut,
            selected,
        ),
        CHECK.StaleResultSafetyCut,
    );
    error.simulation.checks = checks;
    assert.deepEqual(formatFailureEvidence(error, selected).coverage, [
        { check: CHECK.RuntimeEntrypoints, status: "passed" },
        { check: CHECK.StaleResultSafetyCut, status: "failed" },
    ]);
});

test("expired or unproved cut keeps healthy runtime evidence without inventing rejection coverage", () => {
    const selected = [CHECK.RuntimeEntrypoints, CHECK.StaleResultSafetyCut];
    const checks = {
        [CHECK.RuntimeEntrypoints]: true,
        [CHECK.StaleResultSafetyCut]: false,
    };
    const error = Object.assign(new Error("Captured attempt expired"), {
        code: STALE_RESULT_CUT_UNREACHED_CODE,
    });
    recordDataPlaneFailureChecks(
        error,
        checks,
        CHECK.StaleResultSafetyCut,
        selected,
    );
    error.simulation = { checks };
    assert.deepEqual(formatFailureEvidence(error, selected).coverage, [
        { check: CHECK.RuntimeEntrypoints, status: "passed" },
        { check: CHECK.StaleResultSafetyCut, status: "unreached" },
    ]);
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
