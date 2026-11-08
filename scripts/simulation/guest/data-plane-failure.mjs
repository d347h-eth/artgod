import { DATA_PLANE_CHECK } from "../qualification-protocol.mjs";
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
