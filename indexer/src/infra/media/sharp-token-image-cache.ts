import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
    buildTokenImageCachePublicPath,
} from "@artgod/shared/media/token-image-cache";
import {
    parseImageDataUriBuffer,
    resolveTokenResourceUri,
} from "@artgod/shared/media/token-resource-uri";
import type {
    TokenImageCacheInput,
    TokenImageCachePort,
    TokenImageCacheResult,
} from "../../ports/token-image-cache.js";

export type SharpTokenImageCacheConfig = {
    rootDir: string;
    ipfsGatewayOrigin: string;
    maxSourceBytes: number;
};

type SourceImagePayload = {
    buffer: Buffer;
    contentType: string | null;
};

const DEFAULT_WEBP_QUALITY = 85;
const TOKEN_IMAGE_FETCH_TIMEOUT_MS = 30_000;

export class SharpTokenImageCache implements TokenImageCachePort {
    constructor(private readonly config: SharpTokenImageCacheConfig) {}

    async cacheTokenImage(
        input: TokenImageCacheInput,
    ): Promise<TokenImageCacheResult> {
        const source = await this.fetchSourceImage(input.sourceImageUrl);
        const cacheKey = buildCacheKey(input);
        const transformed = await transformImage(source, input);
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

    private async fetchSourceImage(uri: string): Promise<SourceImagePayload> {
        const resolved = resolveTokenResourceUri(uri, {
            ipfsGatewayOrigin: this.config.ipfsGatewayOrigin,
        });
        if (!resolved) {
            throw new Error("Unsupported image URI");
        }

        if (resolved.startsWith("data:")) {
            const data = parseImageDataUriBuffer(resolved);
            assertSourceLimit(data.buffer.byteLength, this.config.maxSourceBytes);
            return {
                buffer: data.buffer,
                contentType: data.contentType,
            };
        }

        if (!/^https?:\/\//i.test(resolved)) {
            throw new Error("Unsupported image URI");
        }

        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(),
            TOKEN_IMAGE_FETCH_TIMEOUT_MS,
        );
        try {
            const response = await fetch(resolved, {
                signal: controller.signal,
                headers: { accept: "image/*,*/*;q=0.1" },
            });
            if (!response.ok) {
                throw new Error(`Image fetch failed: HTTP ${response.status}`);
            }
            const contentLength = Number(response.headers.get("content-length"));
            if (
                Number.isFinite(contentLength) &&
                contentLength > this.config.maxSourceBytes
            ) {
                throw new Error(
                    `Image payload exceeds ${this.config.maxSourceBytes} bytes`,
                );
            }

            return {
                buffer: await readResponseBufferWithLimit(
                    response,
                    this.config.maxSourceBytes,
                ),
                contentType: normalizeContentType(
                    response.headers.get("content-type"),
                ),
            };
        } finally {
            clearTimeout(timer);
        }
    }
}

async function transformImage(
    source: SourceImagePayload,
    input: TokenImageCacheInput,
): Promise<{
    buffer: Buffer;
    contentType: string;
    extension: string;
    width: number | null;
    height: number | null;
}> {
    if (input.requestedMaxDimension !== null) {
        const output = await sharp(source.buffer, {
            animated: false,
        })
            .rotate()
            .resize({
                width: input.requestedMaxDimension,
                height: input.requestedMaxDimension,
                fit: "inside",
                withoutEnlargement: true,
            })
            .webp({ quality: DEFAULT_WEBP_QUALITY })
            .toBuffer({ resolveWithObject: true });
        return {
            buffer: output.data,
            contentType: "image/webp",
            extension: "webp",
            width: output.info.width ?? null,
            height: output.info.height ?? null,
        };
    }

    const metadata = await sharp(source.buffer, {
        animated: false,
    })
        .metadata()
        .catch(() => null);
    const contentType =
        normalizeContentType(source.contentType) ??
        inferImageContentType(source.buffer) ??
        "application/octet-stream";
    return {
        buffer: source.buffer,
        contentType,
        extension: extensionForContentType(contentType),
        width: metadata?.width ?? null,
        height: metadata?.height ?? null,
    };
}

async function readResponseBufferWithLimit(
    response: Response,
    maxBytes: number,
): Promise<Buffer> {
    const body = response.body;
    if (!body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        assertSourceLimit(buffer.byteLength, maxBytes);
        return buffer;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        assertSourceLimit(received, maxBytes);
        chunks.push(value);
    }
    return Buffer.concat(chunks, received);
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

function safeTokenPathSegment(tokenId: string): string {
    if (/^\d+$/.test(tokenId)) {
        return tokenId;
    }
    return crypto.createHash("sha256").update(tokenId).digest("hex").slice(0, 32);
}

function assertSourceLimit(bytes: number, maxBytes: number): void {
    if (bytes > maxBytes) {
        throw new Error(`Image payload exceeds ${maxBytes} bytes`);
    }
}

function normalizeContentType(value: string | null): string | null {
    const normalized = value?.split(";")[0]?.trim().toLowerCase() ?? "";
    return normalized || null;
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
