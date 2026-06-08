import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";

type TokenImageCachePathRow = {
    relative_path: string;
};

export class SqliteTokenImageCacheMaintenance {
    private readonly selectCollectionPathsStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "SELECT relative_path FROM token_image_cache " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND relative_path IS NOT NULL",
    );

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
        const rows = this.selectCollectionPathsStmt.all(
            input,
        ) as TokenImageCachePathRow[];
        this.deleteCollectionRowsStmt.run(input);

        for (const row of rows) {
            await this.deleteCachedFile(row.relative_path, input);
        }
    }

    private async deleteCachedFile(
        relativePath: string,
        context: { chainId: number; collectionId: number },
    ): Promise<void> {
        const target = resolveSafeCachedFile(this.rootDir, relativePath);
        if (!target) {
            logger.warn("Token image cache file cleanup skipped", {
                component: "TokenImageCacheMaintenance",
                action: "deleteCachedFile",
                chainId: context.chainId,
                collectionId: context.collectionId,
                relativePath,
            });
            return;
        }

        await fs.rm(target, { force: true }).catch((error) => {
            logger.warn("Token image cache file cleanup failed", {
                component: "TokenImageCacheMaintenance",
                action: "deleteCachedFile",
                chainId: context.chainId,
                collectionId: context.collectionId,
                relativePath,
                error: String(error),
            });
        });
    }
}

function resolveSafeCachedFile(
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
