import path from "node:path";
import { resolveProjectPath } from "../utils/paths.js";

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
