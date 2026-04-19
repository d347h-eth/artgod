// Shared bidding defaults keep runtime config and adapters aligned on one env contract.
export const BIDDING_DEFAULT_POLL_MS = 8 * 60 * 1000;
export const BIDDING_DEFAULT_MAX_CONCURRENT_JOBS = 1;
export const BIDDING_DEFAULT_BOOTSTRAP_CONCURRENCY = 3;
export const BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS = (3 * 60 + 52) * 60;
export const BIDDING_DEFAULT_COLLECTION_OFFERS_POLL_MS = 60_000;
export const BIDDING_DEFAULT_COLLECTION_OFFERS_TTL_MS = 15_000;
export const BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES = 5;
export const BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE = 100;

// These tracked trait sets preserve the production token-criteria matching behavior by collection.
export const BIDDING_DEFAULT_CRITERIA_REFRESH_TRAITS_BY_COLLECTION = {
    terraforms: ["Zone", "Biome", "Level"],
};

export const BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION = {
    terraforms: ["Zone", "Biome", "Level", "Mode"],
};
