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
import {
    BootstrapImageCacheEstimateError,
    type BootstrapImageCacheEstimatePort,
} from "../../application/use-cases/bootstrap/estimate-bootstrap-image-cache.js";
import { bootstrapImageFetchFailure } from "./bootstrap-resource-failure.js";
import { loadSharp, type SharpFactoryLoader } from "./sharp-loader.js";
import {
    BOOTSTRAP_OUTPUT_STEP as Step,
    BOOTSTRAP_OUTPUT_STATUS as Status,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
import { bootstrapResourceObserver } from "../bootstrap/resource-output.js";

export type SharpBootstrapImageCacheEstimateConfig = {
    ipfsGatewayOrigin: string;
    maxSourceBytes: number;
    fetchResilience: HttpFetchResilienceConfig;
    sharpLoader?: SharpFactoryLoader;
};

export class SharpBootstrapImageCacheEstimateAdapter implements BootstrapImageCacheEstimatePort {
    constructor(
        private readonly config: SharpBootstrapImageCacheEstimateConfig,
    ) {}

    async estimateCacheOutput(
        input: {
            sourceImageUrl: string;
            sourceImageBytes: number | null;
            maxDimension: number | null;
        },
        report?: BootstrapOutputReporter,
    ): Promise<{
        sourceBytes: number | null;
        cachedBytes: number;
        contentType: string | null;
        sampleCachedImageDataUrl: string | null;
        sourceWidth: number | null;
        sourceHeight: number | null;
        width: number | null;
        height: number | null;
    }> {
        report?.({
            step: Step.ImageDownload,
            status: Status.Started,
            message: "Load sample image",
            ...(input.sourceImageUrl.startsWith("data:")
                ? {}
                : { url: input.sourceImageUrl }),
        });
        const source = await fetchTokenImageCacheSource({
            sourceImageUrl: input.sourceImageUrl,
            ipfsGatewayOrigin: this.config.ipfsGatewayOrigin,
            maxSourceBytes: this.config.maxSourceBytes,
            fetchResilience: this.config.fetchResilience,
            observe: bootstrapResourceObserver(report, Step.ImageDownload),
        }).catch((cause: unknown) => {
            report?.({
                step: Step.ImageDownload,
                status: Status.Failed,
                message: bootstrapImageFetchFailure(
                    cause,
                    input.sourceImageUrl,
                ),
            });
            throw new BootstrapImageCacheEstimateError(
                bootstrapImageFetchFailure(cause, input.sourceImageUrl),
                cause,
            );
        });
        report?.({
            step: Step.ImageDownload,
            status: Status.Succeeded,
            message: `Image received · ${source.buffer.byteLength} bytes · ${source.contentType ?? "unknown content type"}`,
        });
        report?.({
            step: Step.ImageProcessing,
            status: Status.Started,
            message:
                input.maxDimension === null
                    ? "Read original image dimensions"
                    : `Resize image · maximum ${input.maxDimension} px · WebP`,
        });
        const sharp = await (this.config.sharpLoader ?? loadSharp)().catch(
            (cause: unknown) => {
                report?.({
                    step: Step.ImageProcessing,
                    status: Status.Failed,
                    message:
                        "Image processing is unavailable. Restart infra and press estimate, or set Image cache mode to off.",
                });
                throw new BootstrapImageCacheEstimateError(
                    "Image processing is unavailable. Restart infra and press estimate, or set Image cache mode to off.",
                    cause,
                );
            },
        );
        const sharpLoader = async () => sharp;
        try {
            const sourceDimensions = await readTokenImageSourceDimensions({
                sourceBuffer: source.buffer,
                sharpLoader,
            });
            report?.({
                step: Step.ImageProcessing,
                status: Status.Succeeded,
                message: `Source image · ${sourceDimensions.width ?? "unknown"} × ${sourceDimensions.height ?? "unknown"} px`,
            });

            if (input.maxDimension === null) {
                report?.({
                    step: Step.ImageProcessing,
                    status: Status.Succeeded,
                    message: `Original image retained · ${source.buffer.byteLength} bytes`,
                });
                const contentType = normalizeImageContentType(
                    source.contentType,
                );
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
            report?.({
                step: Step.ImageProcessing,
                status: Status.Succeeded,
                message: `Cached image · ${transformed.width} × ${transformed.height} px · ${transformed.buffer.byteLength} bytes · ${transformed.contentType}`,
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
        } catch (cause) {
            report?.({
                step: Step.ImageProcessing,
                status: Status.Failed,
                message:
                    "Image decode or resize failed. Choose another image field and press estimate, or set caching to off.",
            });
            throw new BootstrapImageCacheEstimateError(
                "Sample image could not be decoded or resized. Set Image cache mode to off, or choose another Image source field and press estimate.",
                cause,
            );
        }
    }
}
