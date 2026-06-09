import type { SettingsDefaultKey } from "./generated-settings-defaults.js";

// Env keys for shared IPFS resolution and local media-cache storage.
export const COMMON_MEDIA_ENV_KEY = {
    IpfsGatewayOrigin: "COMMON_IPFS_GATEWAY_ORIGIN",
    MediaCacheDir: "COMMON_MEDIA_CACHE_DIR",
} as const satisfies Record<string, SettingsDefaultKey>;
