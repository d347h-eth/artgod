import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";

export class SqliteTokenImageCacheMaintenance {
    private readonly deleteCollectionRowsStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "DELETE FROM token_image_cache " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );

    constructor(private readonly rootDir: string) {}

    async deleteCollectionImageCache(input: {
        chainId: number;
        collectionId: number;
    }): Promise<void> {
        this.deleteCollectionRowsStmt.run(input);
        await this.deleteCollectionImageCacheDirectory(input);
    }

    async deleteCollectionImageCacheDirectory(input: {
        chainId: number;
        collectionId: number;
    }): Promise<void> {
        const target = resolveSafeCachePath(
            this.rootDir,
            path.join(String(input.chainId), String(input.collectionId)),
        );
        if (!target) {
            logger.warn("Token image cache directory cleanup skipped", {
                component: "TokenImageCacheMaintenance",
                action: "deleteCollectionImageCacheDirectory",
                chainId: input.chainId,
                collectionId: input.collectionId,
            });
            return;
        }

        await fs.rm(target, { recursive: true, force: true }).catch((error) => {
            logger.warn("Token image cache directory cleanup failed", {
                component: "TokenImageCacheMaintenance",
                action: "deleteCollectionImageCacheDirectory",
                chainId: input.chainId,
                collectionId: input.collectionId,
                error: String(error),
            });
        });
    }
}

function resolveSafeCachePath(
    rootDir: string,
    relativePath: string,
): string | null {
    const root = path.resolve(rootDir);
    const target = path.resolve(root, relativePath);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
        return null;
    }
    return target;
}
