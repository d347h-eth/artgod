import { CHECK_COVERAGE_STATUS } from "../qualification-protocol.mjs";

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
