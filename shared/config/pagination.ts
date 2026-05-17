export const DEFAULT_PAGE_LIMIT = 250;
export const MAX_PAGE_LIMIT = DEFAULT_PAGE_LIMIT;

// Names shared cursor pagination query parameters used by backend and frontend adapters.
export const PAGINATION_QUERY_PARAMS = {
    Limit: "limit",
    Cursor: "cursor",
} as const;
