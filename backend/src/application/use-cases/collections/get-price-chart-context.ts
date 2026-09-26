import {
    COLLECTION_MEDIA_MODES,
    type CollectionMediaPreferenceValue,
} from "@artgod/shared/extensions";
import type {
    ChainRecord,
    CollectionListItem,
    CollectionMediaState,
} from "@artgod/shared/types/browse";
import type { CollectionPriceChartContext } from "@artgod/shared/types/price-history";

export type GetPriceChartContextInput = {
    chainRef: string;
    collectionRef: string;
    mediaPreference?: CollectionMediaPreferenceValue;
};
export interface GetPriceChartContextPort {
    getPriceChartContext(
        input: GetPriceChartContextInput,
    ): CollectionPriceChartContext;
}

/** Chart navigation/card context without browsing tokens or calculating trait facets. */
export class GetPriceChartContextUseCase implements GetPriceChartContextPort {
    constructor(
        private readonly defaultChainId: number,
        private readonly chains: {
            resolveChainRef(ref: string, defaultChainId: number): ChainRecord;
        },
        private readonly collections: {
            resolveCollectionRef(
                chainId: number,
                ref: string,
            ): CollectionListItem;
            getCollectionMediaState(input: {
                chainId: number;
                collectionId: number;
                mediaMode?: string;
                mediaPreference?: CollectionMediaPreferenceValue;
            }): CollectionMediaState;
        },
    ) {}
    getPriceChartContext(
        input: GetPriceChartContextInput,
    ): CollectionPriceChartContext {
        const chain = this.chains.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collections.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        const media = this.collections.getCollectionMediaState({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
            mediaPreference: input.mediaPreference,
        });
        return { chain, collection, media };
    }
}
