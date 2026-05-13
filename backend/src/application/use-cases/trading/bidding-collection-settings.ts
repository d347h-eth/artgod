import { formatEther } from "viem";
import {
    DEFAULT_TRADING_BIDDING_PRICE_DELTA_WEI,
    TRADING_BIDDING_COLLECTION_SETTING_KEY,
    TRADING_BIDDING_TIER_SELECTION_MODE,
    type TradingBiddingCollectionSettingsRecord,
    type TradingBiddingCollectionSettingKey,
    type TradingBiddingTierSelectionMode,
} from "@artgod/shared/types";
import type { CollectionSettingsRepositoryPort } from "./bidding-price-tier-ports.js";
import { parsePositiveEthToWei, TradingValidationError } from "./types.js";

export type BiddingCollectionSettingsView = {
    tierSelectionMode: TradingBiddingTierSelectionMode;
    defaultDeltaEth: string;
    updatedAt: string | null;
};

// Maps collection bidding settings into the frontend/API view shape.
export function mapBiddingCollectionSettingsToView(
    settings: TradingBiddingCollectionSettingsRecord,
): BiddingCollectionSettingsView {
    return {
        tierSelectionMode: settings.tierSelectionMode,
        defaultDeltaEth: formatEther(BigInt(settings.defaultDeltaWei)),
        updatedAt: settings.updatedAt || null,
    };
}

// Reads generic collection settings and resolves the bidding-specific defaults.
export function readBiddingCollectionSettings(
    repository: Pick<CollectionSettingsRepositoryPort, "getCollectionSetting">,
    params: {
        chainId: number;
        collectionId: number;
    },
): TradingBiddingCollectionSettingsRecord {
    const tierSelectionMode = readSettingString(
        repository,
        params,
        TRADING_BIDDING_COLLECTION_SETTING_KEY.TierSelectionMode,
        TRADING_BIDDING_TIER_SELECTION_MODE.Buttons,
    );
    const defaultDeltaWei = readSettingString(
        repository,
        params,
        TRADING_BIDDING_COLLECTION_SETTING_KEY.DefaultDeltaWei,
        DEFAULT_TRADING_BIDDING_PRICE_DELTA_WEI,
    );

    return {
        chainId: params.chainId,
        collectionId: params.collectionId,
        tierSelectionMode: parseBiddingTierSelectionMode(tierSelectionMode.value),
        defaultDeltaWei: defaultDeltaWei.value,
        createdAt: latestTimestamp([tierSelectionMode.createdAt, defaultDeltaWei.createdAt]),
        updatedAt: latestTimestamp([tierSelectionMode.updatedAt, defaultDeltaWei.updatedAt]),
    };
}

// Writes bidding defaults through the generic collection settings persistence boundary.
export function writeBiddingCollectionSettings(
    repository: Pick<
        CollectionSettingsRepositoryPort,
        "getCollectionSetting" | "upsertCollectionSetting"
    >,
    input: {
        chainId: number;
        collectionId: number;
        tierSelectionMode: TradingBiddingTierSelectionMode;
        defaultDeltaWei: string;
    },
): TradingBiddingCollectionSettingsRecord {
    repository.upsertCollectionSetting({
        chainId: input.chainId,
        collectionId: input.collectionId,
        key: TRADING_BIDDING_COLLECTION_SETTING_KEY.TierSelectionMode,
        valueJson: JSON.stringify(input.tierSelectionMode),
    });
    repository.upsertCollectionSetting({
        chainId: input.chainId,
        collectionId: input.collectionId,
        key: TRADING_BIDDING_COLLECTION_SETTING_KEY.DefaultDeltaWei,
        valueJson: JSON.stringify(input.defaultDeltaWei),
    });

    return readBiddingCollectionSettings(repository, input);
}

// Parses a human-facing Ether delta into the persisted wei string for settings/tier use.
export function parseBiddingDefaultDeltaEth(value: string): string {
    return parsePositiveEthToWei(value, "defaultDeltaEth");
}

// Validates transport-level tier selection mode before persistence.
export function parseBiddingTierSelectionMode(
    value: string,
): TradingBiddingTierSelectionMode {
    if (
        value === TRADING_BIDDING_TIER_SELECTION_MODE.Buttons ||
        value === TRADING_BIDDING_TIER_SELECTION_MODE.Dropdown
    ) {
        return value;
    }
    throw new TradingValidationError("tierSelectionMode is invalid");
}

function readSettingString(
    repository: Pick<CollectionSettingsRepositoryPort, "getCollectionSetting">,
    params: {
        chainId: number;
        collectionId: number;
    },
    key: TradingBiddingCollectionSettingKey,
    fallback: string,
): {
    value: string;
    createdAt: string;
    updatedAt: string;
} {
    const setting = repository.getCollectionSetting({
        ...params,
        key,
    });
    if (!setting) {
        return {
            value: fallback,
            createdAt: "",
            updatedAt: "",
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(setting.valueJson);
    } catch {
        throw new TradingValidationError(`${key} is invalid`);
    }
    if (typeof parsed !== "string" || parsed.trim().length === 0) {
        throw new TradingValidationError(`${key} is invalid`);
    }
    return {
        value: parsed,
        createdAt: setting.createdAt,
        updatedAt: setting.updatedAt,
    };
}

function latestTimestamp(values: string[]): string {
    return values
        .filter((value) => value.trim().length > 0)
        .sort()
        .at(-1) ?? "";
}
