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
    slug: string | null;
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
    address: string;
};

export type TokenCursor = {
    tokenId: string;
};

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

export type CursorPage<TItem> = {
    items: TItem[];
    nextCursor: string | null;
    limit: number;
};

export type TokenCursorPage = CursorPage<TokenCard> & {
    prevCursor: string | null;
    totalItems: number;
    rangeStart: number;
    rangeEnd: number;
    currentPage: number;
    totalPages: number;
};
