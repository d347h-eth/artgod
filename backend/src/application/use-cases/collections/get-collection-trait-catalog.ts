import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
import {
    type CatalogRequest,
    type CatalogScopeReadPort,
    resolveTraitScope,
    ordinaryViewTraits,
} from "./collection-views.js";
import type {
    ChainRecord,
    CollectionListItem,
    TraitCatalog,
    TraitCatalogFacet,
    TraitFilter,
} from "@artgod/shared/types/browse";
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";

export type GetCollectionTraitCatalogInput = CatalogRequest & {
    chainRef: string;
    collectionRef: string;
    keys: string[];
    scopeTraitFilters: TraitFilter[];
};

export type GetCollectionTraitCatalogOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    traitCatalog: TraitCatalog;
};

export type GetCollectionTraitCatalogPort = {
    getCollectionTraitCatalog(
        input: GetCollectionTraitCatalogInput,
    ):
        | GetCollectionTraitCatalogOutput
        | Promise<GetCollectionTraitCatalogOutput>;
};

export class GetCollectionTraitCatalogUseCase implements GetCollectionTraitCatalogPort {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly traitCatalogReadPort: CatalogScopeReadPort & {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
            listCollectionTraitCatalog(params: {
                traitContext?: TraitReadContext;
                chainId: number;
                collectionId: number;
                keys: string[];
                scopeTraitFilters?: TraitFilter[];
            }): TraitCatalogFacet[];
        },
        readonly apm: ApmPort = NOOP_APM,
    ) {}

    getCollectionTraitCatalog(
        input: GetCollectionTraitCatalogInput,
    ): GetCollectionTraitCatalogOutput {
        const chain = this.apm.withSyncSpan(
            "backend.collection_trait_catalog.chain",
            {},
            () =>
                this.chainRefResolverPort.resolveChainRef(
                    input.chainRef,
                    this.defaultChainId,
                ),
        );
        const collection = this.apm.withSyncSpan(
            "backend.collection_trait_catalog.collection",
            {
                [ARTGOD_SPAN_ATTRIBUTE.ChainId]: chain.publicChainId,
            },
            () =>
                this.traitCatalogReadPort.resolveCollectionRef(
                    chain.publicChainId,
                    input.collectionRef,
                ),
        );
        const { traitContext, view } = resolveTraitScope(
            this.traitCatalogReadPort,
            collection,
            input,
        );
        const spanAttributes = {
            [ARTGOD_SPAN_ATTRIBUTE.ChainId]: chain.publicChainId,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: collection.collectionId,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitCatalogKeysCount]:
                input.keys.length,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitFiltersCount]:
                input.scopeTraitFilters.length,
        };

        // Read exact minted counts without changing token-browser facet semantics.
        const facets = this.apm.withSyncSpan(
            "backend.collection_trait_catalog.facets",
            spanAttributes,
            () =>
                this.traitCatalogReadPort.listCollectionTraitCatalog({
                    traitContext,
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    keys: input.keys,
                    scopeTraitFilters: ordinaryViewTraits(
                        view?.pinnedTraits ?? [],
                        input.scopeTraitFilters,
                    ),
                }),
        );

        return {
            chain,
            collection,
            traitCatalog: {
                scope: input.scopeTraitFilters,
                facets,
            },
        };
    }
}
