import {
    fetchTokenImageCacheSource,
    normalizeImageContentType,
} from "@artgod/shared/media/token-image-cache-source";
import { buildImageDataUri } from "@artgod/shared/media/token-resource-uri";
import {
    readTokenImageSourceDimensions,
    resizeTokenImageCacheSourceToWebp,
} from "@artgod/shared/media/token-image-cache-transform";
import type { HttpFetchResilienceConfig } from "@artgod/shared/network/http-fetch-resilience";
import type { BootstrapImageCacheEstimatePort } from "../../application/use-cases/bootstrap/estimate-bootstrap-image-cache.js";
import {
    loadSharp,
    type SharpFactoryLoader,
} from "./sharp-loader.js";

export type SharpBootstrapImageCacheEstimateConfig = {
    ipfsGatewayOrigin: string;
    maxSourceBytes: number;
    fetchResilience: HttpFetchResilienceConfig;
    sharpLoader?: SharpFactoryLoader;
};

export class SharpBootstrapImageCacheEstimateAdapter
    implements BootstrapImageCacheEstimatePort
{
    constructor(private readonly config: SharpBootstrapImageCacheEstimateConfig) {}

    async estimateCacheOutput(input: {
        sourceImageUrl: string;
        sourceImageBytes: number | null;
        maxDimension: number | null;
    }): Promise<{
        sourceBytes: number | null;
        cachedBytes: number;
        contentType: string | null;
        sampleCachedImageDataUrl: string | null;
        sourceWidth: number | null;
        sourceHeight: number | null;
        width: number | null;
        height: number | null;
    }> {
        const source = await fetchTokenImageCacheSource({
            sourceImageUrl: input.sourceImageUrl,
            ipfsGatewayOrigin: this.config.ipfsGatewayOrigin,
            maxSourceBytes: this.config.maxSourceBytes,
            fetchResilience: this.config.fetchResilience,
        });
        const sharpLoader = this.config.sharpLoader ?? loadSharp;
        const sourceDimensions = await readTokenImageSourceDimensions({
            sourceBuffer: source.buffer,
            sharpLoader,
        });

        if (input.maxDimension === null) {
            const contentType = normalizeImageContentType(source.contentType);
            return {
                sourceBytes: source.buffer.byteLength,
                cachedBytes: source.buffer.byteLength,
                contentType,
                sampleCachedImageDataUrl: contentType
                    ? buildImageDataUri({
                          contentType,
                          buffer: source.buffer,
                      })
                    : null,
                sourceWidth: sourceDimensions.width,
                sourceHeight: sourceDimensions.height,
                width: sourceDimensions.width,
                height: sourceDimensions.height,
            };
        }

        const transformed = await resizeTokenImageCacheSourceToWebp({
            sourceBuffer: source.buffer,
            requestedMaxDimension: input.maxDimension,
            sharpLoader,
        });
        return {
            sourceBytes: source.buffer.byteLength,
            cachedBytes: transformed.buffer.byteLength,
            contentType: transformed.contentType,
            sampleCachedImageDataUrl: buildImageDataUri({
                contentType: transformed.contentType,
                buffer: transformed.buffer,
            }),
            sourceWidth: sourceDimensions.width,
            sourceHeight: sourceDimensions.height,
            width: transformed.width,
            height: transformed.height,
        };
    }
}
