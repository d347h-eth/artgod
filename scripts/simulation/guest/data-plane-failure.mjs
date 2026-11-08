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
        // False marks an active, unfinished stage. Preserve prior passed work;
        // actor death does not establish a failure of the stage's safety oracle.
        if (
            activeCheck !== DATA_PLANE_CHECK.RuntimeEntrypoints &&
            checks[activeCheck] === false
        )
            delete checks[activeCheck];
        if (checks[DATA_PLANE_CHECK.StaleResultSafetyCut] === false)
            delete checks[DATA_PLANE_CHECK.StaleResultSafetyCut];
        return DATA_PLANE_CHECK.RuntimeEntrypoints;
    }
    if (expectedChecks.includes(activeCheck)) checks[activeCheck] = false;
    if (isStaleResultCutUnreached(error))
        delete checks[DATA_PLANE_CHECK.StaleResultSafetyCut];
    return activeCheck;
}
