// Number of visual cells in each blockspace grid axis.
export const BLOCKSPACE_GRID_DIMENSION = 32;

// Total visual buckets shown for a blockspace range.
export const BLOCKSPACE_GRID_CELL_COUNT =
    BLOCKSPACE_GRID_DIMENSION * BLOCKSPACE_GRID_DIMENSION;

// Collection context key for chain-wide block coverage.
export const BLOCKSPACE_CONTEXT_ANY = "any";

// Names blockspace query parameters shared by frontend links and backend adapters.
export const BLOCKSPACE_QUERY_PARAMS = {
    Collection: "collection",
    PageStart: "page_start",
    BucketSize: "bucket_size",
    FromBlock: "from_block",
    ToBlock: "to_block",
} as const;
