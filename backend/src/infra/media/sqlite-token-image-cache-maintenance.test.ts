import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SqliteTokenImageCacheMaintenance } from "./sqlite-token-image-cache-maintenance.js";

const cacheDirs: string[] = [];
const dbDirs: string[] = [];

beforeAll(async () => {
    const dbDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "artgod-token-image-maintenance-db-"),
    );
    dbDirs.push(dbDir);
    setDbPath(path.join(dbDir, "main.sqlite"));
    await createMigrationRunner().runMigrations();
});

afterEach(async () => {
    await Promise.all(
        cacheDirs
            .splice(0)
            .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
});

afterAll(async () => {
    await Promise.all(
        dbDirs
            .splice(0)
            .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
});

describe("SqliteTokenImageCacheMaintenance", () => {
    it("removes the whole collection cache directory", async () => {
        const cacheRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "artgod-token-image-maintenance-"),
        );
        cacheDirs.push(cacheRoot);

        await fs.mkdir(path.join(cacheRoot, "1", "7", "5081"), {
            recursive: true,
        });
        await fs.mkdir(path.join(cacheRoot, "1", "8", "1"), {
            recursive: true,
        });
        await fs.writeFile(
            path.join(cacheRoot, "1", "7", "5081", "fresh.webp"),
            "fresh",
        );
        await fs.writeFile(
            path.join(cacheRoot, "1", "7", "5081", "stale.webp"),
            "stale",
        );
        await fs.writeFile(
            path.join(cacheRoot, "1", "8", "1", "other.webp"),
            "other",
        );

        const maintenance = new SqliteTokenImageCacheMaintenance(cacheRoot);
        await maintenance.deleteCollectionImageCacheDirectory({
            chainId: 1,
            collectionId: 7,
        });

        await expect(fs.stat(path.join(cacheRoot, "1", "7"))).rejects.toThrow();
        await expect(
            fs.readFile(path.join(cacheRoot, "1", "8", "1", "other.webp"), {
                encoding: "utf8",
            }),
        ).resolves.toBe("other");
    });
});
