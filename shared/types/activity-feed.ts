import type { ForwardCursorPage, TokenPresentationSummary } from "./browse.js";

export const ACTIVITY_FEED_FILTER_KIND = {
    Sales: "sales",
    Listings: "listings",
    Transfers: "transfers",
} as const;

export type ActivityFeedFilterKind =
    (typeof ACTIVITY_FEED_FILTER_KIND)[keyof typeof ACTIVITY_FEED_FILTER_KIND];

export const ACTIVITY_SCOPE_KIND = {
    Token: "token",
    Collection: "collection",
    Attribute: "attribute",
} as const;

export type ActivityScopeKind =
    (typeof ACTIVITY_SCOPE_KIND)[keyof typeof ACTIVITY_SCOPE_KIND];

export const ACTIVITY_KIND = {
    Transfer: "transfer",
    Sale: "sale",
    ListingCreated: "listing_created",
    ListingCancelled: "listing_cancelled",
    BidCreated: "bid_created",
    BidCancelled: "bid_cancelled",
    Custom: "custom",
} as const;

export type ActivityKind = (typeof ACTIVITY_KIND)[keyof typeof ACTIVITY_KIND];

export const ACTIVITY_SOURCE_KIND = {
    Onchain: "onchain",
    Offchain: "offchain",
    Extension: "extension",
} as const;

export type ActivitySourceKind =
    (typeof ACTIVITY_SOURCE_KIND)[keyof typeof ACTIVITY_SOURCE_KIND];

export type ActivityFeedItem = {
    id: number;
    scopeKind: ActivityScopeKind;
    kind: ActivityKind;
    contract: string;
    tokenId: string | null;
    occurredAt: number;
    sourceKind: ActivitySourceKind;
    sourceName: string;
    orderId: string | null;
    blockNumber: number | null;
    txHash: string | null;
    logIndex: number | null;
    from: string | null;
    to: string | null;
    maker: string | null;
    taker: string | null;
    side: "buy" | "sell" | null;
    amount: string | null;
    price: string | null;
    currency: string | null;
    payload: Record<string, unknown> | null;
    isCollapsed: boolean;
    collapsedEventCount: number | null;
    collapsedWindowStartUtc: number | null;
    collapsedWindowEndUtc: number | null;
};

export type ActivityFeedCursor = {
    filterKind: ActivityFeedFilterKind | null;
    extensionEvent: ActivityExtensionEventRef | null;
    occurredAt: number;
    id: number;
};

export type ActivityFeedPage = ForwardCursorPage<ActivityFeedItem> & {
    prevCursor: string | null;
};

export type ActivityFeedIncludes = {
    tokensById: Record<string, TokenPresentationSummary>;
    eventMediaByActivityId: Record<string, ActivityEventMedia>;
    hasTraitSummaryTemplate: boolean;
};

export type ActivityEventMedia = {
    image: string | null;
    animationUrl: string | null;
    htmlContent?: string | null;
    mediaRef: string;
    renderModes?: { key: string; label: string }[];
};

export type ActivityExtensionEventRef = {
    extensionKey: string;
    eventKey: string;
};

export type ActivityExtensionEventFeed = ActivityExtensionEventRef & {
    label: string;
    filters?: {
        tokenId?: { label: string };
        maker?: { label: string };
        contentHash?: { label: string };
    };
};

export type ActivityExtensionEventFilter = ActivityExtensionEventRef & {
    tokenId?: string;
    maker?: string;
    contentHash?: string;
};
