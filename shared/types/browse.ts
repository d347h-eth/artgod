import type {
    CollectionExtensionKey,
    CollectionMediaPresentation,
} from "../extensions/index.js";
import type { ActivityExtensionEventFeed } from "./activity-feed.js";
import type { TraitFilterDisplayKind } from "./customization.js";

// Names NFT token standards accepted by collection bootstrap and browse flows.
export const COLLECTION_STANDARD = {
    Erc721: "erc721",
    Erc1155: "erc1155",
} as const;

export type CollectionStandard =
    (typeof COLLECTION_STANDARD)[keyof typeof COLLECTION_STANDARD];

// Names collection lifecycle states shared by backend, frontend, and workers.
export const COLLECTION_STATUS = {
    Prepared: "prepared",
    Bootstrapping: "bootstrapping",
    Live: "live",
    Paused: "paused",
    Disabled: "disabled",
} as const;

export type CollectionStatus =
    (typeof COLLECTION_STATUS)[keyof typeof COLLECTION_STATUS];

// Ordered collection lifecycle states accepted by API filters and UI controls.
export const COLLECTION_STATUSES = [
    COLLECTION_STATUS.Prepared,
    COLLECTION_STATUS.Bootstrapping,
    COLLECTION_STATUS.Live,
    COLLECTION_STATUS.Paused,
    COLLECTION_STATUS.Disabled,
] as const satisfies readonly CollectionStatus[];

// Names OpenSea collection bootstrap states persisted on collections.
export const OPENSEA_COLLECTION_STATUS = {
    Pending: "pending",
    IdentityRunning: "identity_running",
    Subscribing: "subscribing",
    SnapshotPending: "snapshot_pending",
    SnapshotRunning: "snapshot_running",
    Ready: "ready",
    Retrying: "retrying",
    Failed: "failed",
} as const;

export type OpenSeaCollectionStatus =
    (typeof OPENSEA_COLLECTION_STATUS)[keyof typeof OPENSEA_COLLECTION_STATUS];

// Names the operator-controlled OpenSea stream ingestion gate persisted per collection.
export const OPENSEA_STREAM_INGESTION_STATUS = {
    Enabled: "enabled",
    Paused: "paused",
} as const;

export type OpenSeaStreamIngestionStatus =
    (typeof OPENSEA_STREAM_INGESTION_STATUS)[keyof typeof OPENSEA_STREAM_INGESTION_STATUS];

// Ordered OpenSea stream gate states accepted by API writes and UI controls.
export const OPENSEA_STREAM_INGESTION_STATUSES = [
    OPENSEA_STREAM_INGESTION_STATUS.Enabled,
    OPENSEA_STREAM_INGESTION_STATUS.Paused,
] as const satisfies readonly OpenSeaStreamIngestionStatus[];

// Checks request/API values before narrowing them to supported stream gate states.
export function isOpenSeaStreamIngestionStatus(
    status: string | null | undefined,
): status is OpenSeaStreamIngestionStatus {
    return Boolean(
        status &&
            OPENSEA_STREAM_INGESTION_STATUSES.includes(
                status as OpenSeaStreamIngestionStatus,
            ),
    );
}

// OpenSea statuses that represent an in-flight collection sync.
export const ACTIVE_OPENSEA_COLLECTION_STATUSES: readonly OpenSeaCollectionStatus[] = [
    OPENSEA_COLLECTION_STATUS.Pending,
    OPENSEA_COLLECTION_STATUS.IdentityRunning,
    OPENSEA_COLLECTION_STATUS.Subscribing,
    OPENSEA_COLLECTION_STATUS.SnapshotPending,
    OPENSEA_COLLECTION_STATUS.SnapshotRunning,
    OPENSEA_COLLECTION_STATUS.Retrying,
];

// Keeps backend guards and frontend actions aligned for OpenSea sync availability.
export function isOpenSeaCollectionSyncActive(
    status: OpenSeaCollectionStatus | null | undefined,
): boolean {
    return Boolean(
        status && ACTIVE_OPENSEA_COLLECTION_STATUSES.includes(status),
    );
}

// Public collection extension summaries expose enabled extension identity without install config.
export type CollectionExtensionSummary = {
    key: CollectionExtensionKey;
};

// Display-only token scope summary for collection admin surfaces.
export type CollectionTokenScopeSummary = {
    label: string;
    items: Array<{
        label: string;
        value: string;
    }>;
};

export type ChainRecord = {
    id: number;
    type: string;
    publicChainId: number;
    slug: string;
    name: string;
    averageBlockTimeSeconds?: number;
    genesisBlockNumber?: number | null;
    genesisBlockTimestamp?: number | null;
};

export type CollectionListItem = {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
    standard: CollectionStandard;
    status: CollectionStatus;
    openseaSlug?: string | null;
    openseaStatus?: OpenSeaCollectionStatus | null;
    openseaReadyAt?: string | null;
    openseaStreamIngestionStatus?: OpenSeaStreamIngestionStatus | null;
    deploymentBlock: number | null;
    bootstrapAnchorBlock: number | null;
    createdAt: string;
    updatedAt: string;
    tokenScope?: CollectionTokenScopeSummary;
    extensions?: CollectionExtensionSummary[];
    activityEventFeeds?: ActivityExtensionEventFeed[];
};

export type CollectionListCursor = {
    createdAt: string;
    slug: string;
};

export type TokenCursor =
    | {
          kind: "all";
          tokenId: string;
      }
    | {
          kind: "listed";
          tokenId: string;
          listingPrice: string;
      }
    | {
          kind: "listed_then_unlisted";
          tokenId: string;
          listingPrice: string | null;
      };

// Names token-browser status filters shared by route parsing and frontend links.
export const TOKEN_BROWSER_STATUS = {
    Listed: "listed",
    All: "all",
    ListedThenUnlisted: "listed_then_unlisted",
} as const;

export type TokenBrowserStatus =
    (typeof TOKEN_BROWSER_STATUS)[keyof typeof TOKEN_BROWSER_STATUS];

// Names collection detail query parameters shared by backend and frontend adapters.
export const COLLECTION_DETAIL_QUERY_PARAMS = {
    TokenStatus: "token_status",
    Owner: "owner",
} as const;

// Names shared trait filter query parameters for collection browse-like routes.
export const TRAIT_FILTER_QUERY_PARAMS = {
    Trait: "trait",
    Traits: "traits",
    TraitRange: "trait_range",
    TraitRanges: "trait_ranges",
} as const;

// Names trait-catalog query parameters shared by backend and frontend adapters.
export const TRAIT_CATALOG_QUERY_PARAMS = {
    Key: "key",
    Keys: "keys",
    ScopeTrait: "scope_trait",
    ScopeTraits: "scope_traits",
} as const;

export type TraitFilter = {
    key: string;
    value: string;
};

export type TraitRangeFilter = {
    key: string;
    fromValue: string | null;
    toValue: string | null;
};

export type TokenAttribute = {
    key: string;
    value: string;
};

// Indicates whether a trait value is backed by canonical token metadata and can be targeted by marketplace bidding APIs.
export type TraitMarketplaceBiddingSupport = {
    marketplaceBiddingSupported: boolean;
};

// Indicates whether a token row is canonical and can be targeted by marketplace bidding APIs.
export type TokenMarketplaceBiddingSupport = {
    marketplaceBiddingSupported: boolean;
};

export type TokenPresentationSummary = TokenMarketplaceBiddingSupport & {
    tokenId: string;
    name: string | null;
    image: string | null;
    traitSummary: string | null;
    hasMetadata: boolean;
    metadataUpdatedAt: string | null;
};

export type TokenCard = TokenPresentationSummary & {
    animationUrl: string | null;
    listingPrice: string | null;
    listingCurrency: string | null;
    attributes: TokenAttribute[];
};

export type TokenDetailTrait = TraitMarketplaceBiddingSupport & {
    key: string;
    value: string;
    tokenCount: number | null;
    rarityPercent: number | null;
};

export type TokenMediaPreview = {
    tokenId: string;
    image: string | null;
    animationUrl: string | null;
};

export type TokenDetail = TokenMarketplaceBiddingSupport & {
    tokenId: string;
    name: string | null;
    image: string | null;
    animationUrl: string | null;
    listingPrice: string | null;
    listingCurrency: string | null;
    currentHolder: string | null;
    attributes: TokenDetailTrait[];
    hasMetadata: boolean;
    metadataUpdatedAt: string | null;
};

export type TraitFacetValue = TraitMarketplaceBiddingSupport & {
    value: string;
    tokenCount: number;
};

export type TraitCatalogFacetValue = {
    value: string;
    tokenCount: number;
};

export type TraitFacet = {
    key: string;
    displayKind: TraitFilterDisplayKind;
    minValue: string | null;
    maxValue: string | null;
    values: TraitFacetValue[];
};

export type TraitCatalogFacet = {
    key: string;
    values: TraitCatalogFacetValue[];
};

export type TraitCatalog = {
    scope: TraitFilter[];
    facets: TraitCatalogFacet[];
};

export type CollectionHolder = {
    owner: string;
    tokenCount: string;
    heldPercent: number | null;
};

export type CursorPage<TItem> = {
    items: TItem[];
    nextCursor: string | null;
    limit: number;
};

export type ForwardCursorPage<TItem> = CursorPage<TItem> & {
    totalItems: number;
    rangeStart: number;
    rangeEnd: number;
    currentPage: number;
    totalPages: number;
};

export type TokenCursorPage = ForwardCursorPage<TokenCard> & {
    prevCursor: string | null;
    marketplaceBiddingSupportedTotalItems: number;
};

export type CollectionHolderPage = ForwardCursorPage<CollectionHolder>;

export type CollectionMediaState = CollectionMediaPresentation;
