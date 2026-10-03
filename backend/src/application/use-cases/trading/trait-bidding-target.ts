import type { TradingTraitCriterion } from "@artgod/shared/types";
import { TradingValidationError } from "./types.js";

export type TraitBiddingTargetSupportReadPort = {
    listMarketplaceBiddingSupportedTraits(params: {
        chainId: number;
        collectionId: number;
        traits: { key: string; value: string }[];
    }): { key: string; value: string }[];
};

// Job declarations and preset targets share the same marketplace eligibility.
export function assertMarketplaceBiddingSupportedTargetTraits(params: {
    chainId: number;
    collectionId: number;
    targetTraits: TradingTraitCriterion[];
    traitBiddingTargetSupportReadPort: TraitBiddingTargetSupportReadPort;
}): void {
    const supported =
        params.traitBiddingTargetSupportReadPort.listMarketplaceBiddingSupportedTraits(
            {
                chainId: params.chainId,
                collectionId: params.collectionId,
                traits: params.targetTraits.map((t) => ({
                    key: t.type,
                    value: t.value,
                })),
            },
        );
    const keys = new Set(
        supported.map((t) => JSON.stringify([t.key, t.value])),
    );
    const unsupported = params.targetTraits.find(
        (t) => !keys.has(JSON.stringify([t.type, t.value])),
    );
    if (unsupported)
        throw new TradingValidationError(
            `target trait is not available for marketplace bidding: ${unsupported.type}=${unsupported.value}`,
        );
}
