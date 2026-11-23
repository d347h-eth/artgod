export const NFT111K_METADATA = {
    Type: "type",
    CollectionBlockAlias: "Collection Block",
    Category: "category",
    CollectionBlock: "collection block",
    Egg: "egg",
    PlaceholderImage: "https://cdn.lil.org/nft/111k/placeholder.png",
    RevealStatus: "revealStatus",
    Revealed: "revealed",
} as const;

/** Prefer the lower-case canonical key when both exact spellings are available. */
export const NFT111K_BLOCK_KEYS = [
    NFT111K_METADATA.CollectionBlock,
    NFT111K_METADATA.CollectionBlockAlias,
] as const;

/** Both source spellings identify artwork blocks, with their case preserved for native criteria. */
export function isNft111kBlockKey(key: unknown): boolean {
    return NFT111K_BLOCK_KEYS.some((blockKey) => blockKey === key);
}
