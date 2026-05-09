import type {
    ActivityEventMedia,
    ActivityFeedIncludes,
    ActivityFeedItem,
    TokenCard,
} from "@artgod/shared/types";
import { buildTokenPresentationIncludes } from "../collections/token-presentation-summary.js";

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
    eventMediaByActivityId: Record<string, ActivityEventMedia> = {},
): ActivityFeedIncludes {
    return {
        ...buildTokenPresentationIncludes(tokens, traitSummaryTemplate),
        eventMediaByActivityId,
    };
}
