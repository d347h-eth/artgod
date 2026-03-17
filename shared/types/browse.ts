export type CollectionStandard = "erc721" | "erc1155";

export type CollectionStatus = "bootstrapping" | "live" | "paused" | "disabled";

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

export type TokenAttribute = {
    key: string;
    value: string;
};

export type TokenCard = {
    tokenId: string;
    name: string | null;
    image: string | null;
    listingPrice: string | null;
    listingCurrency: string | null;
    attributes: TokenAttribute[];
    hasMetadata: boolean;
    metadataUpdatedAt: string | null;
};

export type TokenDetailTrait = {
    key: string;
    value: string;
    tokenCount: number | null;
    rarityPercent: number | null;
};

export type TokenDetail = {
    tokenId: string;
    name: string | null;
    image: string | null;
    animationUrl: string | null;
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
    values: TraitFacetValue[];
};

export type CollectionHolder = {
    owner: string;
    tokenCount: string;
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
