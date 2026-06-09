// Token attribute source kinds identify the owner of normalized trait links.
export const TOKEN_ATTRIBUTE_SOURCE_KIND = {
    Metadata: "metadata",
    CollectionExtension: "collection_extension",
} as const;

export type TokenAttributeSourceKind =
    (typeof TOKEN_ATTRIBUTE_SOURCE_KIND)[keyof typeof TOKEN_ATTRIBUTE_SOURCE_KIND];

// Canonical metadata is the source key for traits parsed from tokenURI payloads.
export const TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY = "canonical";
