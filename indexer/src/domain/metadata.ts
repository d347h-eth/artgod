export type TokenStandard = "erc721" | "erc1155";

export type MetadataAttribute = {
    traitType?: string;
    value?: string | number | boolean;
    displayType?: string;
};

// Token metadata attribute container fields seen in NFT JSON payloads.
export const TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD = {
    Attributes: "attributes",
    Features: "features",
    Traits: "traits",
} as const;

// Token metadata attribute item fields normalized into canonical attributes.
export const TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD = {
    AttributeType: "attribute_type",
    AttributeTypeCamel: "attributeType",
    DisplayType: "display_type",
    DisplayTypeCamel: "displayType",
    Key: "key",
    Name: "name",
    Trait: "trait",
    TraitName: "trait_name",
    TraitNameCamel: "traitName",
    TraitType: "trait_type",
    TraitTypeCamel: "traitType",
    TraitValue: "trait_value",
    TraitValueCamel: "traitValue",
    Type: "type",
    Value: "value",
    AttributeValue: "attribute_value",
    AttributeValueCamel: "attributeValue",
} as const;

// Trait-like container-name fragments gate broad heuristic key/value parsing.
export const TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD_FRAGMENT = {
    Attribute: "attribute",
    Feature: "feature",
    Trait: "trait",
    Property: "propert",
} as const;

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
    collectionId: number;
    contract: string;
    tokenId: string;
    image: string | null;
};

export type MetadataDomainSyncResult = {
    contracts: string[];
    updatedTokens: MetadataUpdatedToken[];
};

export type MetadataRefreshResult = MetadataUpdatedToken | null;
