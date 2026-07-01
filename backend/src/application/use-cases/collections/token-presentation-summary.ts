import type { TokenCard, TokenPresentationSummary } from "@artgod/shared/types";
import {
    normalizeTraitSummaryTemplateConfig,
    renderTraitSummaryTemplate,
} from "@artgod/shared/types";

export type TokenPresentationIncludes = {
    tokensById: Record<string, TokenPresentationSummary>;
    hasTraitSummaryTemplate: boolean;
};

export function buildTokenPresentationIncludes(
    tokens: TokenCard[],
    traitSummaryTemplate: string,
): TokenPresentationIncludes {
    const tokensById: Record<string, TokenPresentationSummary> = {};
    const hasTraitSummaryTemplate =
        normalizeTraitSummaryTemplateConfig({
            template: traitSummaryTemplate,
        }).template.length > 0;

    for (const token of tokens) {
        tokensById[token.tokenId] = mapTokenCardToPresentationSummary(
            token,
            traitSummaryTemplate,
        );
    }

    return { tokensById, hasTraitSummaryTemplate };
}

function mapTokenCardToPresentationSummary(
    token: TokenCard,
    traitSummaryTemplate: string,
): TokenPresentationSummary {
    return {
        tokenId: token.tokenId,
        marketplaceBiddingSupported: token.marketplaceBiddingSupported,
        name: token.name,
        image: token.image,
        traitSummary: renderTraitSummaryTemplate(
            traitSummaryTemplate,
            token.attributes,
        ),
        hasMetadata: token.hasMetadata,
        metadataUpdatedAt: token.metadataUpdatedAt,
    };
}
