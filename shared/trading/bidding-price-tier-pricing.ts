import { parseEther } from "viem";
import {
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
    TRADING_BIDDING_PRICE_TIER_DELTA_KIND,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
    type TradingBiddingPriceTierCeilingConfig,
    type TradingBiddingPriceTierDeltaKind,
    type TradingBiddingPriceTierFloorConfig,
} from "../types/trading.js";

const PERCENT_SCALE = 1_000_000n;
const PERCENT_BASE = 100n * PERCENT_SCALE;

// Shared by persisted tier resolution and the editor's live delta validation.
// Percent offsets retain six decimal places and truncate fractional wei.
export function resolveBiddingPriceTierFloorWei(
    config: TradingBiddingPriceTierFloorConfig,
    parentFloorWei?: bigint,
): bigint {
    if (config.kind === TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed) {
        return parsePositiveEthAmount(config.valueEth, "floorConfig.valueEth");
    }
    if (parentFloorWei === undefined) {
        throw new RangeError("floorConfig requires a parent tier");
    }
    return applyDelta(parentFloorWei, config, "floorConfig");
}

export function resolveBiddingPriceTierCeilingWei(
    config: TradingBiddingPriceTierCeilingConfig,
    floorWei: bigint,
    parentCeilingWei?: bigint,
): bigint {
    if (config.kind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed) {
        return parsePositiveEthAmount(
            config.valueEth,
            "ceilingConfig.valueEth",
        );
    }
    if (
        config.kind ===
        TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta
    ) {
        return applyDelta(floorWei, config, "ceilingConfig");
    }
    if (parentCeilingWei === undefined) {
        throw new RangeError("ceilingConfig requires a parent tier");
    }
    return applyDelta(parentCeilingWei, config, "ceilingConfig");
}

function applyDelta(
    baseWei: bigint,
    config: {
        deltaKind: TradingBiddingPriceTierDeltaKind;
        deltaEth?: string;
        percent?: string;
    },
    field: string,
): bigint {
    const value =
        config.deltaKind === TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute
            ? baseWei +
              parseSignedEthAmount(config.deltaEth, `${field}.deltaEth`)
            : baseWei +
              (baseWei *
                  parseSignedPercent(config.percent, `${field}.percent`)) /
                  PERCENT_BASE;
    if (value <= 0n) {
        throw new RangeError(`${field} resolves to a non-positive price`);
    }
    return value;
}

function parsePositiveEthAmount(
    value: string | undefined,
    field: string,
): bigint {
    if (!value?.trim()) {
        throw new RangeError(`${field} is required`);
    }
    const parsed = parseEthAmount(value.trim(), field);
    if (parsed <= 0n) {
        throw new RangeError(`${field} must be > 0`);
    }
    return parsed;
}

function parseSignedEthAmount(
    value: string | undefined,
    field: string,
): bigint {
    if (!value?.trim()) {
        throw new RangeError(`${field} is required`);
    }
    return parseEthAmount(value.trim(), field);
}

function parseEthAmount(value: string, field: string): bigint {
    try {
        const sign = value.startsWith("-") ? -1n : 1n;
        const unsigned =
            value.startsWith("-") || value.startsWith("+")
                ? value.slice(1)
                : value;
        if (!unsigned) {
            throw new Error("empty numeric value");
        }
        return sign * parseEther(unsigned);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RangeError(`${field} is invalid: ${message}`);
    }
}

function parseSignedPercent(value: string | undefined, field: string): bigint {
    if (!value?.trim()) {
        throw new RangeError(`${field} is required`);
    }
    const normalized = value.trim();
    const sign = normalized.startsWith("-") ? -1n : 1n;
    const unsigned =
        normalized.startsWith("-") || normalized.startsWith("+")
            ? normalized.slice(1)
            : normalized;
    if (!/^\d+(\.\d+)?$/.test(unsigned)) {
        throw new RangeError(`${field} is invalid`);
    }
    const [whole, fraction = ""] = unsigned.split(".");
    const paddedFraction = fraction.padEnd(6, "0").slice(0, 6);
    return sign * (BigInt(whole) * PERCENT_SCALE + BigInt(paddedFraction));
}
