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

    it("caches original bytes without loading sharp when resize is disabled", async () => {
        const source = Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"></svg>',
        );
        const cache = new SharpTokenImageCache({
            rootDir: tempDir,
            ipfsGatewayOrigin: "https://ipfs.io",
            maxSourceBytes: 1024 * 1024,
            sharpLoader: async () => {
                throw new Error("sharp should not load for passthrough");
            },
        });

        const result = await cache.cacheTokenImage({
            chainId: 1,
            collectionId: 2,
            tokenId: "7",
            sourceImageUrl: `data:image/svg+xml;base64,${source.toString("base64")}`,
            requestedMaxDimension: null,
        });

        expect(result.contentType).toBe("image/svg+xml");
        expect(result.width).toBe(null);
        expect(result.height).toBe(null);
        expect(result.publicPath).toMatch(
            /^\/media\/token-images\/1\/2\/7\/[a-f0-9]+\.svg$/,
        );
        const cachedPath = join(tempDir, result.relativePath);
        expect(readFileSync(cachedPath)).toEqual(source);
        expect(result.sourceBytes).toBe(source.byteLength);
        expect(result.cachedBytes).toBe(source.byteLength);
    });
});
