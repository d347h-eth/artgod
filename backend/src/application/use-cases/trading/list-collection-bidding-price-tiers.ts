import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type {
    CollectionSettingsRepositoryPort,
    BiddingPriceTiersRepositoryPort,
} from "./bidding-price-tier-ports.js";
import {
    mapBiddingCollectionSettingsToView,
    readBiddingCollectionSettings,
    type BiddingCollectionSettingsView,
} from "./bidding-collection-settings.js";
import {
    mapResolvedBiddingPriceTierToView,
    resolveBiddingPriceTierGraph,
    type BiddingPriceTierView,
} from "./bidding-price-tiers.js";

export type ListCollectionBiddingPriceTiersInput = {
    chainRef: string;
    collectionRef: string;
};

export type ListCollectionBiddingPriceTiersOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    settings: BiddingCollectionSettingsView;
    tiers: BiddingPriceTierView[];
};

export class ListCollectionBiddingPriceTiersUseCase {
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
        readonly biddingPriceTiersRepositoryPort: Pick<
            BiddingPriceTiersRepositoryPort,
            "listCollectionPriceTiers"
        >,
        readonly collectionSettingsRepositoryPort: Pick<
            CollectionSettingsRepositoryPort,
            "getCollectionSetting"
        >,
    ) {}

    listCollectionBiddingPriceTiers(
        input: ListCollectionBiddingPriceTiersInput,
    ): ListCollectionBiddingPriceTiersOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before reading collection-scoped price tiers.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Load active tier definitions and resolve them into current scalar prices.
        const tiers = resolveBiddingPriceTierGraph(
            this.biddingPriceTiersRepositoryPort.listCollectionPriceTiers({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            }),
        ).map((tier) => mapResolvedBiddingPriceTierToView(tier));
        // Load collection-scoped bidding UI defaults alongside the tier read model.
        const settings = mapBiddingCollectionSettingsToView(
            readBiddingCollectionSettings(this.collectionSettingsRepositoryPort, {
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            }),
        );

        return {
            chain,
            collection,
            settings,
            tiers,
        };
    }
}
