import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SharpTokenImageCache } from "../src/infra/media/sharp-token-image-cache.js";

describe("SharpTokenImageCache", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-token-image-cache-"));
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("caches resized data URI images under the public media path", async () => {
        const source = await sharp({
            create: {
                width: 4,
                height: 2,
                channels: 4,
                background: "#ff0000ff",
            },
        })
            .png()
            .toBuffer();
        const cache = new SharpTokenImageCache({
            rootDir: tempDir,
            ipfsGatewayOrigin: "https://ipfs.io",
            maxSourceBytes: 1024 * 1024,
        });

        const result = await cache.cacheTokenImage({
            chainId: 1,
            collectionId: 2,
            tokenId: "7",
            sourceImageUrl: `data:image/png;base64,${source.toString("base64")}`,
            requestedMaxDimension: 2,
        });

        expect(result.contentType).toBe("image/webp");
        expect(result.width).toBe(2);
        expect(result.height).toBe(1);
        expect(result.publicPath).toMatch(
            /^\/media\/token-images\/1\/2\/7\/[a-f0-9]+\.webp$/,
        );
        const cachedPath = join(tempDir, result.relativePath);
        expect(existsSync(cachedPath)).toBe(true);
        expect(readFileSync(cachedPath).byteLength).toBe(result.cachedBytes);
    });
});
