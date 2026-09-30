// Bounds the bootstrap token-image cache resizing control shared by API and UI.
export const BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION = 64;
export const BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION = 4096;
export const BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION = 2400;
export const BOOTSTRAP_IMAGE_CACHE_DEFAULT_MAX_SOURCE_BYTES = 25 * 1024 * 1024;

// Bounds metadata downloaded or decoded for one bootstrap probe and returned for inspection.
export const BOOTSTRAP_TOKEN_URI_MAX_BYTES = 10 * 1024 * 1024;

// Request bounds shared by bootstrap admission and the setup form.
export const BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT = 50_000;
export const BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT = 1_000_000;
export const BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH = 80;
export const BOOTSTRAP_TOKEN_ID_MAX_LENGTH = 78;
