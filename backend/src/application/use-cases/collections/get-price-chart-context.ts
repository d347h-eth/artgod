import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
import {
    type CatalogRequest,
    type CatalogScopeReadPort,
    resolveTraitScope,
    ordinaryViewTraits,
} from "./collection-views.js";
import type { CollectionMediaPreferenceValue } from "@artgod/shared/extensions";
import type {
    ChainRecord,
    CollectionListItem,
    CollectionMediaState,
    TraitFacet,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import { applyTraitFilterPresentationToFacets } from "@artgod/shared/read-models/collections";
import type { CollectionPriceChartContext } from "@artgod/shared/types/price-history";

export type GetPriceChartContextInput = CatalogRequest & {
    chainRef: string;
    collectionRef: string;
    mediaMode?: string;
    mediaPreference?: CollectionMediaPreferenceValue;
    traits: TraitFilter[];
    traitRanges: TraitRangeFilter[];
};
export interface GetPriceChartContextPort {
    getPriceChartContext(
        input: GetPriceChartContextInput,
    ): CollectionPriceChartContext;
}

/** Chart navigation, media and the same collection-wide facets as the token browser. */
export class GetPriceChartContextUseCase implements GetPriceChartContextPort {
    constructor(
        private readonly defaultChainId: number,
        private readonly chains: {
            resolveChainRef(ref: string, defaultChainId: number): ChainRecord;
        },
        private readonly collections: CatalogScopeReadPort & {
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
            listCollectionTraitFacets(
                chainId: number,
                collectionId: number,
                owner?: string,
                options?: {
                    traitContext?: TraitReadContext;
                    rangeOnlyKeys?: string[];
                },
            ): TraitFacet[];
        },
        private readonly customization: {
            getTraitFilterPresentationState(input: {
                chainId: number;
                collectionId: number;
            }): { effectiveConfig: { rangeKeys: string[] } };
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
        const { traitContext, view: selectedView } = resolveTraitScope(
            this.collections,
            collection,
            input,
        );
        const ordinaryTraits = ordinaryViewTraits(
            selectedView?.pinnedTraits ?? [],
            input.traits,
        );
        const media = this.collections.getCollectionMediaState({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            mediaMode: input.mediaMode,
            mediaPreference: input.mediaPreference,
        });
        const scope = {
            traitContext,
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
        };
        const config =
            this.customization.getTraitFilterPresentationState(
                scope,
            ).effectiveConfig;
        const facets = applyTraitFilterPresentationToFacets({
            facets: this.collections.listCollectionTraitFacets(
                scope.chainId,
                scope.collectionId,
                undefined,
                { traitContext, rangeOnlyKeys: config.rangeKeys },
            ),
            config,
        });
        return {
            chain,
            collection,
            media,
            traits: {
                selected: ordinaryTraits,
                selectedRanges: input.traitRanges,
                facets,
            },
        };
    }
}
