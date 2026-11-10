import { DATA_PLANE_CHECK } from "../qualification-protocol.mjs";
import {
    isStaleResultCutRuntimeFailure,
    isStaleResultCutUnreached,
} from "./stale-result-cut.mjs";
import {
    findRuntimeProcessExit,
    RUNTIME_PROCESS_PROPERTY,
} from "./runtime-process.mjs";

/** Attribute a cut's actor death to runtime execution, preserving oracle reach. */
export function recordDataPlaneFailureChecks(
    error,
    checks,
    activeCheck,
    expectedChecks,
) {
    const exit = findRuntimeProcessExit(error);
    if (exit || isStaleResultCutRuntimeFailure(error)) {
        // An oracle wrapper may have overwritten the outer error or typed
        // cause label. Normalize from the lifecycle owner's constant.
        if (exit) error.property = RUNTIME_PROCESS_PROPERTY.Liveness;
        checks[DATA_PLANE_CHECK.RuntimeEntrypoints] = false;
        // A check can remain unfinished across several stages, such as initial
        // HTTP observation through final projection. Assertions fail fast, so
        // an actor exit cannot establish failure of any unfinished safety check.
        // Preserve every check whose complete oracle already passed.
        for (const [check, passed] of Object.entries(checks))
            if (
                check !== DATA_PLANE_CHECK.RuntimeEntrypoints &&
                passed === false
            )
                delete checks[check];
        return DATA_PLANE_CHECK.RuntimeEntrypoints;
    }
    if (expectedChecks.includes(activeCheck)) checks[activeCheck] = false;
    if (isStaleResultCutUnreached(error))
        delete checks[DATA_PLANE_CHECK.StaleResultSafetyCut];
    return activeCheck;
}
