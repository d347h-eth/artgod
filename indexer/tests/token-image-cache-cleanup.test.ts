import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SharpTokenImageCache } from "../src/infra/media/sharp-token-image-cache.js";

describe("token image cache cleanup", () => {
    let tempDir = "";

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(join(tmpdir(), "artgod-token-image-cache-"));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("deletes cached files without allowing traversal outside the root", async () => {
        const cache = new SharpTokenImageCache({
            rootDir: tempDir,
            ipfsGatewayOrigin: "https://ipfs.io",
            maxSourceBytes: 1024 * 1024,
        });
        const cachedPath = join(tempDir, "1", "7", "1", "cache.webp");
        const outsideName = `${basename(tempDir)}-outside-cache.webp`;
        const outsidePath = join(tempDir, "..", outsideName);
        await fs.mkdir(join(tempDir, "1", "7", "1"), { recursive: true });
        await fs.writeFile(cachedPath, "cached");
        await fs.writeFile(outsidePath, "outside");

        try {
            await cache.deleteCachedTokenImage("1/7/1/cache.webp");
            await cache.deleteCachedTokenImage(`../${outsideName}`);

            expect(existsSync(cachedPath)).toBe(false);
            expect(readFileSync(outsidePath, "utf8")).toBe("outside");
        } finally {
            await fs.rm(outsidePath, { force: true });
        }
    });
});
