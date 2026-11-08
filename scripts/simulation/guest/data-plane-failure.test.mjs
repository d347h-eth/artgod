import assert from "node:assert/strict";
import test from "node:test";
import { DATA_PLANE_CHECK as CHECK } from "../qualification-protocol.mjs";
import { formatFailureEvidence } from "./failure-evidence.mjs";
import { recordDataPlaneFailureChecks } from "./data-plane-failure.mjs";
import {
    STALE_RESULT_PROPERTY,
    STALE_RESULT_CUT_UNREACHED_CODE,
} from "./stale-result-cut.mjs";

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
