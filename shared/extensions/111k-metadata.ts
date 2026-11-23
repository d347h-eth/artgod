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

/** Both source spellings identify artwork blocks, with their case preserved for native criteria. */
export function isNft111kBlockKey(key: unknown): boolean {
    return (
        key === NFT111K_METADATA.CollectionBlock ||
        key === NFT111K_METADATA.CollectionBlockAlias
    );
}
