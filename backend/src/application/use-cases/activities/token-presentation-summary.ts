import type {
    ActivityFeedIncludes,
    ActivityFeedItem,
    TokenCard,
    TokenPresentationSummary,
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
): ActivityFeedIncludes {
    const tokensById: Record<string, TokenPresentationSummary> = {};

    for (const token of tokens) {
        tokensById[token.tokenId] = mapTokenCardToPresentationSummary(token);
    }

    return { tokensById };
}

function mapTokenCardToPresentationSummary(
    token: TokenCard,
): TokenPresentationSummary {
    return {
        tokenId: token.tokenId,
        name: token.name,
        image: token.image,
        hasMetadata: token.hasMetadata,
        metadataUpdatedAt: token.metadataUpdatedAt,
    };
}
