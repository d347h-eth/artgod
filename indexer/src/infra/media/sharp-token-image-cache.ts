import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type sharp from "sharp";
import { buildTokenImageCachePublicPath } from "@artgod/shared/media/token-image-cache";
import {
    fetchTokenImageCacheSource,
    normalizeImageContentType,
} from "@artgod/shared/media/token-image-cache-source";
import { resizeTokenImageCacheSourceToWebp } from "@artgod/shared/media/token-image-cache-transform";
import { getDefaultHttpFetchResilienceConfig } from "@artgod/shared/config/http-fetch-resilience";
import type { HttpFetchResilienceConfig } from "@artgod/shared/network/http-fetch-resilience";
import { logger } from "@artgod/shared/utils";
import type {
    TokenImageCacheInput,
    TokenImageCachePort,
    TokenImageCacheResult,
} from "../../ports/token-image-cache.js";

export type SharpTokenImageCacheConfig = {
    rootDir: string;
    ipfsGatewayOrigin: string;
    maxSourceBytes: number;
    fetchResilience?: HttpFetchResilienceConfig;
    sharpLoader?: SharpFactoryLoader;
};

type SourceImagePayload = {
    buffer: Buffer;
    contentType: string | null;
};

export type SharpFactory = typeof sharp;
export type SharpFactoryLoader = () => Promise<SharpFactory>;

let sharpFactoryPromise: Promise<SharpFactory> | null = null;

export class SharpTokenImageCache implements TokenImageCachePort {
    private readonly fetchResilience: HttpFetchResilienceConfig;

    constructor(private readonly config: SharpTokenImageCacheConfig) {
        this.fetchResilience =
            config.fetchResilience ?? getDefaultHttpFetchResilienceConfig();
    }

    async cacheTokenImage(
        input: TokenImageCacheInput,
    ): Promise<TokenImageCacheResult> {
        const source = await this.fetchSourceImage(input.sourceImageUrl);
        const cacheKey = buildCacheKey(input);
        const transformed = await transformImage(
            source,
            input,
            this.config.sharpLoader ?? loadSharp,
        );
        const relativePath = buildRelativePath({
            chainId: input.chainId,
            collectionId: input.collectionId,
            tokenId: input.tokenId,
            cacheKey,
            extension: transformed.extension,
        });
        const absolutePath = path.join(this.config.rootDir, relativePath);

        // Write atomically so backend readers never see a partial image file.
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        const tmpPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmpPath, transformed.buffer);
        await fs.rename(tmpPath, absolutePath);

        return {
            cacheKey,
            contentType: transformed.contentType,
            sourceBytes: source.buffer.byteLength,
            cachedBytes: transformed.buffer.byteLength,
            width: transformed.width,
            height: transformed.height,
            relativePath,
            publicPath: buildTokenImageCachePublicPath(relativePath),
        };
    }

    async deleteCachedTokenImage(relativePath: string): Promise<void> {
        const target = resolveSafeCachedPath(this.config.rootDir, relativePath);
        if (!target) {
            logger.warn("Token image cache file cleanup skipped", {
                component: "SharpTokenImageCache",
                action: "deleteCachedTokenImage",
                relativePath,
            });
            return;
        }

        await fs.rm(target, { force: true }).catch((error) => {
            logger.warn("Token image cache file cleanup failed", {
                component: "SharpTokenImageCache",
                action: "deleteCachedTokenImage",
                relativePath,
                error: String(error),
            });
        });
    }

    private async fetchSourceImage(uri: string): Promise<SourceImagePayload> {
        return await fetchTokenImageCacheSource({
            sourceImageUrl: uri,
            ipfsGatewayOrigin: this.config.ipfsGatewayOrigin,
            maxSourceBytes: this.config.maxSourceBytes,
            fetchResilience: this.fetchResilience,
        });
    }
}

async function transformImage(
    source: SourceImagePayload,
    input: TokenImageCacheInput,
    sharpLoader: SharpFactoryLoader,
): Promise<{
    buffer: Buffer;
    contentType: string;
    extension: string;
    width: number | null;
    height: number | null;
}> {
    if (input.requestedMaxDimension !== null) {
        return await resizeTokenImageCacheSourceToWebp({
            sourceBuffer: source.buffer,
            requestedMaxDimension: input.requestedMaxDimension,
            sharpLoader,
        });
    }

    const contentType =
        normalizeImageContentType(source.contentType) ??
        inferImageContentType(source.buffer) ??
        "application/octet-stream";
    return {
        buffer: source.buffer,
        contentType,
        extension: extensionForContentType(contentType),
        width: null,
        height: null,
    };
}

async function loadSharp(): Promise<SharpFactory> {
    if (!sharpFactoryPromise) {
        // Load sharp only when native image processing is actually requested.
        sharpFactoryPromise = import("sharp").then((module) => {
            const loaded = module as unknown as { default?: SharpFactory };
            return loaded.default ?? (module as unknown as SharpFactory);
        });
    }
    return sharpFactoryPromise;
}

function buildCacheKey(input: TokenImageCacheInput): string {
    return crypto
        .createHash("sha256")
        .update(input.sourceImageUrl)
        .update("\0")
        .update(String(input.requestedMaxDimension ?? "original"))
        .digest("hex")
        .slice(0, 32);
}

function buildRelativePath(input: {
    chainId: number;
    collectionId: number;
    tokenId: string;
    cacheKey: string;
    extension: string;
}): string {
    return path.posix.join(
        String(input.chainId),
        String(input.collectionId),
        safeTokenPathSegment(input.tokenId),
        `${input.cacheKey}.${input.extension}`,
    );
}

function resolveSafeCachedPath(
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

function safeTokenPathSegment(tokenId: string): string {
    if (/^\d+$/.test(tokenId)) {
        return tokenId;
    }
    return crypto
        .createHash("sha256")
        .update(tokenId)
        .digest("hex")
        .slice(0, 32);
}

function inferImageContentType(buffer: Buffer): string | null {
    if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
        return "image/png";
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "image/jpeg";
    }
    if (buffer.subarray(0, 6).toString("ascii") === "GIF87a") {
        return "image/gif";
    }
    if (buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
        return "image/gif";
    }
    if (
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
        return "image/webp";
    }
    if (buffer.subarray(0, 256).toString("utf8").includes("<svg")) {
        return "image/svg+xml";
    }
    return null;
}

function extensionForContentType(contentType: string): string {
    if (contentType === "image/png") return "png";
    if (contentType === "image/jpeg") return "jpg";
    if (contentType === "image/gif") return "gif";
    if (contentType === "image/webp") return "webp";
    if (contentType === "image/svg+xml") return "svg";
    return "bin";
}
