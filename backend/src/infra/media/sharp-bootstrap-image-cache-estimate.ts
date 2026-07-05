import type sharp from "sharp";
import {
    fetchTokenImageCacheSource,
    normalizeImageContentType,
} from "@artgod/shared/media/token-image-cache-source";
import { resizeTokenImageCacheSourceToWebp } from "@artgod/shared/media/token-image-cache-transform";
import type { HttpFetchResilienceConfig } from "@artgod/shared/network/http-fetch-resilience";
import type { BootstrapImageCacheEstimatePort } from "../../application/use-cases/bootstrap/estimate-bootstrap-image-cache.js";

export type SharpBootstrapImageCacheEstimateConfig = {
    ipfsGatewayOrigin: string;
    maxSourceBytes: number;
    fetchResilience: HttpFetchResilienceConfig;
    sharpLoader?: SharpFactoryLoader;
};

export type SharpFactory = typeof sharp;
export type SharpFactoryLoader = () => Promise<SharpFactory>;

let sharpFactoryPromise: Promise<SharpFactory> | null = null;

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
        width: number | null;
        height: number | null;
    }> {
        if (input.maxDimension === null && input.sourceImageBytes !== null) {
            return {
                sourceBytes: input.sourceImageBytes,
                cachedBytes: input.sourceImageBytes,
                contentType: null,
                width: null,
                height: null,
            };
        }

        const source = await fetchTokenImageCacheSource({
            sourceImageUrl: input.sourceImageUrl,
            ipfsGatewayOrigin: this.config.ipfsGatewayOrigin,
            maxSourceBytes: this.config.maxSourceBytes,
            fetchResilience: this.config.fetchResilience,
        });

        if (input.maxDimension === null) {
            return {
                sourceBytes: source.buffer.byteLength,
                cachedBytes: source.buffer.byteLength,
                contentType: normalizeImageContentType(source.contentType),
                width: null,
                height: null,
            };
        }

        const transformed = await resizeTokenImageCacheSourceToWebp({
            sourceBuffer: source.buffer,
            requestedMaxDimension: input.maxDimension,
            sharpLoader: this.config.sharpLoader ?? loadSharp,
        });
        return {
            sourceBytes: source.buffer.byteLength,
            cachedBytes: transformed.buffer.byteLength,
            contentType: transformed.contentType,
            width: transformed.width,
            height: transformed.height,
        };
    }
}

async function loadSharp(): Promise<SharpFactory> {
    if (!sharpFactoryPromise) {
        sharpFactoryPromise = import("sharp").then((module) => {
            const loaded = module as unknown as { default?: SharpFactory };
            return loaded.default ?? (module as unknown as SharpFactory);
        });
    }
    return sharpFactoryPromise;
}
