import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
    TRADING_BIDDING_PRICE_TIER_DELTA_KIND,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
    type TradingBiddingPriceTierCeilingConfig,
    type TradingBiddingPriceTierFloorConfig,
} from "@artgod/shared/types";
import {
    parseEditableBiddingJobStatus,
    parseOptionalString,
    parseRequiredString,
} from "./trading-job-http.js";

export type ParsedPriceTierBody = {
    tierId?: string;
    name: string;
    status: "enabled" | "paused";
    sortOrder: number;
    parentTierId: string | null;
    floorConfig: TradingBiddingPriceTierFloorConfig;
    ceilingConfig: TradingBiddingPriceTierCeilingConfig;
};

// Parses collection price-tier transport fields before domain graph validation.
export function parsePriceTierBody(value: Record<string, unknown>): ParsedPriceTierBody {
    return {
        tierId: parseOptionalString(value.tierId, "tierId"),
        name: parseRequiredString(value.name, "name"),
        status: parseEditableBiddingJobStatus(value.status),
        sortOrder: parseSortOrder(value.sortOrder),
        parentTierId: parseOptionalString(value.parentTierId, "parentTierId") ?? null,
        floorConfig: parseFloorConfig(value.floorConfig),
        ceilingConfig: parseCeilingConfig(value.ceilingConfig),
    };
}

function parseSortOrder(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new ReadModelBadRequestError("sortOrder must be an integer");
    }
    return value;
}

function parseFloorConfig(value: unknown): TradingBiddingPriceTierFloorConfig {
    const record = parseObject(value, "floorConfig");
    if (record.kind === TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed) {
        return {
            kind: record.kind,
            valueEth: parseRequiredString(record.valueEth, "floorConfig.valueEth"),
        };
    }
    if (record.kind === TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta) {
        return {
            kind: record.kind,
            ...parseDelta(record, "floorConfig"),
        };
    }
    throw new ReadModelBadRequestError("floorConfig.kind is invalid");
}

function parseCeilingConfig(value: unknown): TradingBiddingPriceTierCeilingConfig {
    const record = parseObject(value, "ceilingConfig");
    if (record.kind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed) {
        return {
            kind: record.kind,
            valueEth: parseRequiredString(record.valueEth, "ceilingConfig.valueEth"),
        };
    }
    if (
        record.kind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta ||
        record.kind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta
    ) {
        return {
            kind: record.kind,
            ...parseDelta(record, "ceilingConfig"),
        };
    }
    throw new ReadModelBadRequestError("ceilingConfig.kind is invalid");
}

function parseDelta(
    record: Record<string, unknown>,
    field: string,
): {
    deltaKind: "absolute" | "percent";
    deltaEth?: string;
    percent?: string;
} {
    if (record.deltaKind === TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute) {
        return {
            deltaKind: record.deltaKind,
            deltaEth: parseRequiredString(record.deltaEth, `${field}.deltaEth`),
        };
    }
    if (record.deltaKind === TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Percent) {
        return {
            deltaKind: record.deltaKind,
            percent: parseRequiredString(record.percent, `${field}.percent`),
        };
    }
    throw new ReadModelBadRequestError(`${field}.deltaKind is invalid`);
}

function parseObject(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object") {
        throw new ReadModelBadRequestError(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
}
