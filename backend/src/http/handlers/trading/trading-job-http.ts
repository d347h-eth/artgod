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

// Parses optional string fields at the HTTP boundary without inventing defaults.
export function parseOptionalString(
    value: unknown,
    field: string,
): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError(`${field} must be a string`);
    }
    return value;
}

// Parses optional positive integer quantities shared by bidding target handlers.
export function parseOptionalQuantity(
    value: unknown,
    field = "quantity",
): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new ReadModelBadRequestError(`${field} must be an integer > 0`);
    }
    return value;
}
