import assert from "node:assert/strict";
import test from "node:test";
import { DATA_PLANE_CHECK as CHECK } from "../qualification-protocol.mjs";
import { formatFailureEvidence } from "./failure-evidence.mjs";
import { recordDataPlaneFailureChecks } from "./data-plane-failure.mjs";
import {
    RuntimeProcessExit,
    RUNTIME_PROCESS_PROPERTY,
} from "./runtime-process.mjs";
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
    const cause = new RuntimeProcessExit({
        actorId: "domain",
        pid: 156,
        signal: "SIGSEGV",
    });
    const error = new Error("Production domain exited (SIGSEGV)", { cause });
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

test("ordinary fork and provider native exits attribute runtime liveness while unfinished oracles remain unreached", () => {
    for (const active of [CHECK.ReorgRecovery, CHECK.ProviderDisagreement]) {
        const selected = [
            CHECK.RuntimeEntrypoints,
            CHECK.ChainAcquisition,
            active,
        ];
        const checks = {
            [CHECK.RuntimeEntrypoints]: true,
            [CHECK.ChainAcquisition]: true,
            [active]: false,
        };
        const error = new RuntimeProcessExit({
            actorId: "domain",
            pid: 154,
            signal: "SIGSEGV",
        });
        assert.equal(error.property, RUNTIME_PROCESS_PROPERTY.Liveness);
        const failedCheck = recordDataPlaneFailureChecks(
            error,
            checks,
            active,
            selected,
        );
        error.simulation = { checks, failedCheck };
        assert.equal(failedCheck, CHECK.RuntimeEntrypoints);
        assert.deepEqual(formatFailureEvidence(error, selected).coverage, [
            { check: CHECK.RuntimeEntrypoints, status: "failed" },
            { check: CHECK.ChainAcquisition, status: "passed" },
            { check: active, status: "unreached" },
        ]);
        const alreadyPassed = {
            [CHECK.RuntimeEntrypoints]: true,
            [active]: true,
        };
        recordDataPlaneFailureChecks(error, alreadyPassed, active, selected);
        assert.equal(
            alreadyPassed[active],
            true,
            "An already demonstrated oracle stays passed",
        );
    }
});

test("a genuine ordinary oracle assertion is not reclassified from a diagnostic SIGSEGV snapshot", () => {
    const checks = {
        [CHECK.RuntimeEntrypoints]: true,
        [CHECK.ReorgRecovery]: false,
    };
    const error = Object.assign(new Error("Retained fork fact"), {
        property: "canonical-facts",
        simulation: { processStates: [{ signalCode: "SIGSEGV" }] },
    });
    assert.equal(
        recordDataPlaneFailureChecks(
            error,
            checks,
            CHECK.ReorgRecovery,
            Object.keys(checks),
        ),
        CHECK.ReorgRecovery,
    );
    assert.equal(checks[CHECK.RuntimeEntrypoints], true);
    assert.equal(checks[CHECK.ReorgRecovery], false);
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

test("the stale cut's explicit liveness wrapper retains log or startup failures as runtime evidence", () => {
    const checks = {
        [CHECK.RuntimeEntrypoints]: true,
        [CHECK.StaleResultSafetyCut]: false,
    };
    const error = Object.assign(new Error("Log write failed: EIO"), {
        property: STALE_RESULT_PROPERTY.Runtime,
    });
    const selected = Object.keys(checks);
    assert.equal(
        recordDataPlaneFailureChecks(
            error,
            checks,
            CHECK.StaleResultSafetyCut,
            selected,
        ),
        CHECK.RuntimeEntrypoints,
    );
    error.simulation = { checks };
    assert.deepEqual(formatFailureEvidence(error, selected).coverage, [
        { check: CHECK.RuntimeEntrypoints, status: "failed" },
        { check: CHECK.StaleResultSafetyCut, status: "unreached" },
    ]);
});
