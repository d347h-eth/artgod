import type {
    ActivityFeedIncludes,
    ActivityFeedItem,
    TokenCard,
    TokenPresentationSummary,
} from "@artgod/shared/types";
import {
    normalizeTraitSummaryTemplateConfig,
    renderTraitSummaryTemplate,
} from "@artgod/shared/types";

export function collectActivityTokenIds(
    items: ActivityFeedItem[],
): string[] {
    const tokenIds: string[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        if (!item.tokenId || seen.has(item.tokenId)) {
            continue;
        }
        seen.add(item.tokenId);
        tokenIds.push(item.tokenId);
    }

    return tokenIds;
}

export function buildActivityFeedIncludes(
    tokens: TokenCard[],
    traitSummaryTemplate: string,
): ActivityFeedIncludes {
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
