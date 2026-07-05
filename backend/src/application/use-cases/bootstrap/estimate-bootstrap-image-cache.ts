import type { ChainRecord } from "@artgod/shared/types/browse";
import {
    BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
    BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION,
} from "@artgod/shared/config/bootstrap";
import {
    IMAGE_CACHE_MODE,
    type ImageCacheMode,
} from "@artgod/shared/media/token-image-cache";
import type { ChainRefResolverPort } from "./ports.js";
import { BootstrapValidationError } from "./types.js";

export type EstimateBootstrapImageCacheInput = {
    chainRef: string;
    sampleTokenId: string;
    sourceImageUrl: string;
    sourceImageBytes: number | null;
    totalSupply: string;
    imageCacheMode: ImageCacheMode;
    maxDimension: number | null;
};

export type EstimateBootstrapImageCacheOutput = {
    chain: ChainRecord;
    sampleTokenId: string;
    imageCacheMode: ImageCacheMode;
    maxDimension: number | null;
    sampleSourceBytes: number | null;
    sampleCachedBytes: number;
    projectedCachedBytes: string;
    totalSupply: string;
    contentType: string | null;
    sourceWidth: number | null;
    sourceHeight: number | null;
    width: number | null;
    height: number | null;
};

export interface BootstrapImageCacheEstimatePort {
    estimateCacheOutput(input: {
        sourceImageUrl: string;
        sourceImageBytes: number | null;
        maxDimension: number | null;
    }): Promise<{
        sourceBytes: number | null;
        cachedBytes: number;
        contentType: string | null;
        sourceWidth: number | null;
        sourceHeight: number | null;
        width: number | null;
        height: number | null;
    }>;
}

export class EstimateBootstrapImageCacheUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly imageCacheEstimatePort: BootstrapImageCacheEstimatePort,
    ) {}

    async estimate(
        input: EstimateBootstrapImageCacheInput,
    ): Promise<EstimateBootstrapImageCacheOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const totalSupply = parsePositiveBigInt(input.totalSupply, "totalSupply");
        const sampleTokenId = input.sampleTokenId.trim();
        if (!sampleTokenId) {
            throw new BootstrapValidationError("sampleTokenId is required");
        }
        if (!input.sourceImageUrl.trim()) {
            throw new BootstrapValidationError("sourceImageUrl is required");
        }

        if (input.imageCacheMode === IMAGE_CACHE_MODE.Off) {
            return {
                chain,
                sampleTokenId,
                imageCacheMode: input.imageCacheMode,
                maxDimension: null,
                sampleSourceBytes: input.sourceImageBytes,
                sampleCachedBytes: 0,
                projectedCachedBytes: "0",
                totalSupply: totalSupply.toString(),
                contentType: null,
                sourceWidth: null,
                sourceHeight: null,
                width: null,
                height: null,
            };
        }

        if (
            input.imageCacheMode !== IMAGE_CACHE_MODE.CacheOnce &&
            input.imageCacheMode !== IMAGE_CACHE_MODE.RefreshOnMetadata
        ) {
            throw new BootstrapValidationError("Invalid imageCacheMode");
        }

        validateMaxDimension(input.maxDimension);
        const estimate = await this.imageCacheEstimatePort.estimateCacheOutput({
            sourceImageUrl: input.sourceImageUrl.trim(),
            sourceImageBytes: input.sourceImageBytes,
            maxDimension: input.maxDimension,
        });
        return {
            chain,
            sampleTokenId,
            imageCacheMode: input.imageCacheMode,
            maxDimension: input.maxDimension,
            sampleSourceBytes: estimate.sourceBytes,
            sampleCachedBytes: estimate.cachedBytes,
            projectedCachedBytes: (
                BigInt(estimate.cachedBytes) * totalSupply
            ).toString(),
            totalSupply: totalSupply.toString(),
            contentType: estimate.contentType,
            sourceWidth: estimate.sourceWidth,
            sourceHeight: estimate.sourceHeight,
            width: estimate.width,
            height: estimate.height,
        };
    }
}

function validateMaxDimension(value: number | null): void {
    if (value === null) return;
    if (
        !Number.isInteger(value) ||
        value < BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION ||
        value > BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION
    ) {
        throw new BootstrapValidationError(
            `image max dimension must be ${BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION}-${BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION}`,
        );
    }
}

function parsePositiveBigInt(value: string, field: string): bigint {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) {
        throw new BootstrapValidationError(`${field} must be a positive integer`);
    }
    const parsed = BigInt(normalized);
    if (parsed <= 0n) {
        throw new BootstrapValidationError(`${field} must be a positive integer`);
    }
    return parsed;
}
