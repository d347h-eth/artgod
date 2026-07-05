import { Buffer } from "node:buffer";

export const TOKEN_IMAGE_CACHE_WEBP_QUALITY = 85;

export type TokenImageCacheSharpFactory = (
    input: Buffer,
    options: { animated: false },
) => {
    metadata(): Promise<{
        width?: number | null;
        height?: number | null;
    }>;
    rotate(): {
        resize(options: {
            width: number;
            height: number;
            fit: "inside";
            withoutEnlargement: true;
        }): {
            webp(options: { quality: number }): {
                toBuffer(options: { resolveWithObject: true }): Promise<{
                    data: Buffer;
                    info: {
                        width?: number | null;
                        height?: number | null;
                    };
                }>;
            };
        };
    };
};

export type TokenImageCacheSharpLoader =
    () => Promise<TokenImageCacheSharpFactory>;

// Source image geometry returned by cache/probe media inspection.
export type TokenImageDimensions = {
    width: number | null;
    height: number | null;
};

// Reads the source image geometry without transforming or caching bytes.
export async function readTokenImageSourceDimensions(input: {
    sourceBuffer: Buffer;
    sharpLoader: TokenImageCacheSharpLoader;
}): Promise<TokenImageDimensions> {
    const sharp = await input.sharpLoader();
    const metadata = await sharp(input.sourceBuffer, {
        animated: false,
    }).metadata();
    return {
        width: metadata.width ?? null,
        height: metadata.height ?? null,
    };
}

export async function resizeTokenImageCacheSourceToWebp(input: {
    sourceBuffer: Buffer;
    requestedMaxDimension: number;
    sharpLoader: TokenImageCacheSharpLoader;
}): Promise<{
    buffer: Buffer;
    contentType: "image/webp";
    extension: "webp";
    width: number | null;
    height: number | null;
}> {
    const sharp = await input.sharpLoader();
    const output = await sharp(input.sourceBuffer, {
        animated: false,
    })
        .rotate()
        .resize({
            width: input.requestedMaxDimension,
            height: input.requestedMaxDimension,
            fit: "inside",
            withoutEnlargement: true,
        })
        .webp({ quality: TOKEN_IMAGE_CACHE_WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true });
    return {
        buffer: output.data,
        contentType: "image/webp",
        extension: "webp",
        width: output.info.width ?? null,
        height: output.info.height ?? null,
    };
}
