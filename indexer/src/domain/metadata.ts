export type TokenStandard = "erc721" | "erc1155";

export type MetadataAttribute = {
    traitType?: string;
    value?: string | number | boolean;
    displayType?: string;
};

export type TokenMetadata = {
    uri: string;
    name?: string;
    description?: string;
    image?: string;
    animationUrl?: string;
    externalUrl?: string;
    attributes: MetadataAttribute[];
    rawJson: string;
};

export type MetadataUpdatedToken = {
    contract: string;
    tokenId: string;
};

export type MetadataDomainSyncResult = {
    contracts: string[];
    updatedTokens: MetadataUpdatedToken[];
};

export type MetadataRefreshResult = MetadataUpdatedToken | null;
