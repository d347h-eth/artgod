import path from "node:path";
import { resolveProjectPath } from "../utils/paths.js";

export const TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX = "/media/token-images";

// Resolves the on-device token-image cache root shared by indexer and backend.
export function resolveTokenImageCacheDir(input: {
    dbPath: string;
    overrideDir?: string | null;
}): string {
    const overrideDir = input.overrideDir?.trim();
    if (overrideDir) {
        return path.isAbsolute(overrideDir)
            ? overrideDir
            : resolveProjectPath(overrideDir);
    }

    const dbPath = path.isAbsolute(input.dbPath)
        ? input.dbPath
        : resolveProjectPath(input.dbPath);
    return path.resolve(path.dirname(dbPath), "../media-cache/token-images");
}

// Builds the root-relative URL stored in read-model rows for cached images.
export function buildTokenImageCachePublicPath(relativePath: string): string {
    const normalized = relativePath
        .split(/[\\/]+/)
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/");
    return `${TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX}/${normalized}`;
}
