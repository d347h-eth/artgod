import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type { CollectionSettingsRepositoryPort } from "./bidding-price-tier-ports.js";
import {
    mapBiddingCollectionSettingsToView,
    parseBiddingDefaultDeltaEth,
    parseBiddingTierSelectionMode,
    writeBiddingCollectionSettings,
    type BiddingCollectionSettingsView,
} from "./bidding-collection-settings.js";

export type UpdateCollectionBiddingSettingsInput = {
    chainRef: string;
    collectionRef: string;
    tierSelectionMode: string;
    defaultDeltaEth: string;
};

export type UpdateCollectionBiddingSettingsOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    settings: BiddingCollectionSettingsView;
};

export class UpdateCollectionBiddingSettingsUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionReadPort: {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
        },
        readonly collectionSettingsRepositoryPort: Pick<
            CollectionSettingsRepositoryPort,
            "getCollectionSetting" | "upsertCollectionSetting"
        >,
    ) {}

    updateCollectionBiddingSettings(
        input: UpdateCollectionBiddingSettingsInput,
    ): UpdateCollectionBiddingSettingsOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before mutating collection-scoped bidding settings.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        const tierSelectionMode = parseBiddingTierSelectionMode(
            input.tierSelectionMode,
        );
        const defaultDeltaWei = parseBiddingDefaultDeltaEth(input.defaultDeltaEth);

        // Persist collection-scoped bidding defaults for future tier and job drafts.
        const settings = writeBiddingCollectionSettings(
            this.collectionSettingsRepositoryPort,
            {
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                tierSelectionMode,
                defaultDeltaWei,
            },
        );

        return {
            chain,
            collection,
            settings: mapBiddingCollectionSettingsToView(settings),
        };
    }
}
