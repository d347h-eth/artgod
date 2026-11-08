import {
    CHECK_COVERAGE_STATUS,
    DATA_PLANE_CHECK,
} from "../qualification-protocol.mjs";
import {
    isStaleResultCutRuntimeFailure,
    isStaleResultCutUnreached,
} from "./stale-result-cut.mjs";

/** Attribute a cut's actor death to runtime execution, preserving oracle reach. */
export function recordDataPlaneFailureChecks(
    error,
    checks,
    activeCheck,
    expectedChecks,
) {
    if (isStaleResultCutRuntimeFailure(error)) {
        checks[DATA_PLANE_CHECK.RuntimeEntrypoints] = false;
        delete checks[DATA_PLANE_CHECK.StaleResultSafetyCut];
        return DATA_PLANE_CHECK.RuntimeEntrypoints;
    }
    if (expectedChecks.includes(activeCheck)) checks[activeCheck] = false;
    if (isStaleResultCutUnreached(error))
        delete checks[DATA_PLANE_CHECK.StaleResultSafetyCut];
    return activeCheck;
}

/** Diagnostic details cannot expand or replace the scenario's declared checks. */
export function formatFailureEvidence(error, expectedChecks) {
    const observed = error.simulation ?? {};
    const checks = Object.fromEntries(
        expectedChecks.map((check) => [
            check,
            observed.checks?.[check] === true,
        ]),
    );
    return {
        error: error.message,
        stack: error.stack,
        ...observed,
        checks,
        coverage: expectedChecks.map((check) => ({
            check,
            status: checks[check]
                ? CHECK_COVERAGE_STATUS.Passed
                : Object.hasOwn(observed.checks ?? {}, check)
                  ? CHECK_COVERAGE_STATUS.Failed
                  : CHECK_COVERAGE_STATUS.Unreached,
        })),
    };
}
