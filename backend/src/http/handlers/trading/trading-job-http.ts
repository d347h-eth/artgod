import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import { TRADING_JOB_STATUS } from "@artgod/shared/types";

// Parses the shared editable bidding job status from admin HTTP payloads.
export function parseEditableBiddingJobStatus(
    value: unknown,
): typeof TRADING_JOB_STATUS.Enabled | typeof TRADING_JOB_STATUS.Paused {
    if (
        value === TRADING_JOB_STATUS.Enabled ||
        value === TRADING_JOB_STATUS.Paused
    ) {
        return value;
    }
    throw new ReadModelBadRequestError("status is invalid");
}

// Parses required string fields at the HTTP boundary before use-case validation.
export function parseRequiredString(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError(`${field} must be a string`);
    }
    return value;
}
