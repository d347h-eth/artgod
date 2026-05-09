import type {
    CollectionExtensionKey,
    CollectionMediaPresentation,
} from "../extensions/index.js";
import type { ActivityExtensionEventFeed } from "./activity-feed.js";
import type { TraitFilterDisplayKind } from "./customization.js";

export type CollectionStandard = "erc721" | "erc1155";

export type CollectionStatus = "bootstrapping" | "live" | "paused" | "disabled";

// Public collection extension summaries expose enabled extension identity without install config.
export type CollectionExtensionSummary = {
    key: CollectionExtensionKey;
};

export type ChainRecord = {
    id: number;
    type: string;
    publicChainId: number;
    slug: string;
    name: string;
};

export type CollectionListItem = {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
    standard: CollectionStandard;
    status: CollectionStatus;
    deploymentBlock: number | null;
    bootstrapAnchorBlock: number | null;
    createdAt: string;
    updatedAt: string;
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

export type TokenBrowserStatus = "listed" | "all" | "listed_then_unlisted";

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

export type TokenPresentationSummary = {
    tokenId: string;
    name: string | null;
    image: string | null;
    traitSummary: string | null;
    hasMetadata: boolean;
    metadataUpdatedAt: string | null;
};

export type TokenCard = TokenPresentationSummary & {
    listingPrice: string | null;
    listingCurrency: string | null;
    attributes: TokenAttribute[];
};

export type TokenDetailTrait = {
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

export type TokenDetail = {
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

export type TraitFacetValue = {
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
};

export type CollectionHolderPage = ForwardCursorPage<CollectionHolder>;

export type CollectionMediaState = CollectionMediaPresentation;
