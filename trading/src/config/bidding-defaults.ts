// Shared bidding defaults keep runtime config and adapters aligned on one env contract.
export const BIDDING_DEFAULT_POLL_MS = 8 * 60 * 1000;
export const BIDDING_DEFAULT_MAX_CONCURRENT_JOBS = 1;
export const BIDDING_DEFAULT_BOOTSTRAP_CONCURRENCY = 3;
export const BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS = (3 * 60 + 52) * 60;
export const BIDDING_DEFAULT_COLLECTION_OFFERS_POLL_MS = 60_000;
export const BIDDING_DEFAULT_COLLECTION_OFFERS_TTL_MS = 15_000;
export const BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES = 5;
export const BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE = 100;
export const BIDDING_DEFAULT_WETH_ALLOWANCE_ETH = "0";
export const BIDDING_DEFAULT_TX_MIN_PRIORITY_FEE_GWEI = "0.1";
export const BIDDING_DEFAULT_TX_FEE_HISTORY_BLOCKS = 20;
export const BIDDING_DEFAULT_TX_FEE_HISTORY_REWARD_PERCENTILE = 70;
export const BIDDING_DEFAULT_TX_BASE_FEE_MULTIPLIER = "1.25";
export const BIDDING_DEFAULT_TX_MAX_FEE_GWEI = "10";
export const BIDDING_DEFAULT_TX_PENDING_NONCE_POLICY = "fail";

// These tracked trait sets preserve the production token-criteria matching behavior by collection.
export const BIDDING_DEFAULT_CRITERIA_REFRESH_TRAITS_BY_COLLECTION = {
    terraforms: ["Zone", "Biome", "Level"],
};

export const BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION = {
    terraforms: ["Zone", "Biome", "Level", "Mode"],
};
