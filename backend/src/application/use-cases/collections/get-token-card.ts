import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
import {
    type CatalogRequest,
    type CatalogScopeReadPort,
    resolveTraitScope,
} from "./collection-views.js";
import type {
    ChainRecord,
    CollectionListItem,
    CollectionMediaState,
    TokenCard,
} from "@artgod/shared/types/browse";
import type { CollectionMediaPreferenceValue } from "@artgod/shared/extensions";
import { renderTraitSummaryTemplate } from "@artgod/shared/types";
import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";

export type GetTokenCardInput = CatalogRequest & {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
    mediaMode?: string;
    mediaPreference?: CollectionMediaPreferenceValue;
};
export type GetTokenCardOutput = {
    media: CollectionMediaState;
    token: TokenCard;
};

/** A single grid card, with the same extension media, current ask and effective
 * trait template as the collection browser. Fullscreen preview stays separate. */
export class GetTokenCardUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolver: {
            resolveChainRef(
                chainRef: string,
                defaultChainId: number,
            ): ChainRecord;
        },
        private readonly cards: CatalogScopeReadPort & {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
            getCollectionMediaState(params: {
                chainId: number;
                collectionId: number;
                mediaMode?: string;
                mediaPreference?: CollectionMediaPreferenceValue;
            }): CollectionMediaState;
            listCollectionTokenCardsByIds(params: {
                traitContext?: TraitReadContext;
                chainId: number;
                collectionId: number;
                tokenIds: string[];
                mediaMode?: string;
                mediaPreference?: CollectionMediaPreferenceValue;
                includeListings: boolean;
            }): TokenCard[];
        },
        private readonly customization: {
            getTokenCardTraitSummaryTemplateState(params: {
                traitContext?: TraitReadContext;
                chainId: number;
                collectionId: number;
            }): { effectiveConfig: { template: string } };
        },
    ) {}

    getTokenCard(input: GetTokenCardInput): GetTokenCardOutput {
        const chain = this.chainRefResolver.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.cards.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        const { traitContext } = resolveTraitScope(
            this.cards,
            collection,
            input,
            input.tokenRef,
        );
        const scope = {
            traitContext,
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
        };
        const media = this.cards.getCollectionMediaState({
            ...scope,
            mediaMode: input.mediaMode,
            mediaPreference: input.mediaPreference,
        });
        const [token] = this.cards.listCollectionTokenCardsByIds({
            ...scope,
            traitContext,
            tokenIds: [input.tokenRef],
            mediaMode: media.selectedMode,
            mediaPreference: input.mediaPreference,
            includeListings: true,
        });
        if (!token) throw new ReadModelNotFoundError("Unknown token");
        const template =
            this.customization.getTokenCardTraitSummaryTemplateState(scope)
                .effectiveConfig.template;
        return {
            media,
            token: {
                ...token,
                traitSummary: renderTraitSummaryTemplate(
                    template,
                    token.attributes,
                ),
            },
        };
    }
}
