import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    isBootstrapStepAction,
    isBootstrapStepKey,
    type BootstrapStepAction,
    type BootstrapStepKey,
} from "@artgod/shared/bootstrap/pipeline";

// Parses the numeric run id shared by bootstrap run routes.
export function parseBootstrapRunId(raw: string): number {
    const value = raw.trim();
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ReadModelBadRequestError("Invalid run_id");
    }
    return parsed;
}

// Parses route step keys against the shared durable bootstrap step contract.
export function parseBootstrapStepKey(raw: string): BootstrapStepKey {
    if (!isBootstrapStepKey(raw)) {
        throw new ReadModelBadRequestError("Invalid step_key");
    }
    return raw;
}

// Parses route action values against the shared step action contract.
export function parseBootstrapStepAction(raw: string): BootstrapStepAction {
    if (!isBootstrapStepAction(raw)) {
        throw new ReadModelBadRequestError("Invalid action");
    }
    return raw;
}
