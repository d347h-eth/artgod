import type { FastifyRequest, FastifyReply } from "fastify";
import {
    BOOTSTRAP_OPERATION,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
import { bootstrapOperationResponse } from "./operation-response.js";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    IMAGE_CACHE_MODE,
    type ImageCacheMode,
} from "@artgod/shared/media/token-image-cache";
import type {
    EstimateBootstrapImageCacheInput,
    EstimateBootstrapImageCacheOutput,
} from "../../../application/use-cases/bootstrap/estimate-bootstrap-image-cache.js";

export type EstimateBootstrapImageCacheRoute = {
    Params: {
        chain_ref: string;
    };
    Body: {
        sampleTokenId?: unknown;
        sourceImageUrl?: unknown;
        sourceImageBytes?: unknown;
        imageCacheMode?: unknown;
        maxDimension?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class EstimateBootstrapImageCacheHttpAdapter {
    constructor(
        private readonly estimateBootstrapImageCachePort: {
            estimate(
                input: EstimateBootstrapImageCacheInput,
                report?: BootstrapOutputReporter,
            ): MaybePromise<EstimateBootstrapImageCacheOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<EstimateBootstrapImageCacheRoute>,
        reply: FastifyReply,
    ) => {
        const input = this.mapRequestToInput(request);
        return bootstrapOperationResponse(
            request,
            reply,
            BOOTSTRAP_OPERATION.Estimate,
            (report) =>
                this.estimateBootstrapImageCachePort.estimate(input, report),
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<EstimateBootstrapImageCacheRoute>,
    ): EstimateBootstrapImageCacheInput {
        const body = request.body ?? {};
        return {
            chainRef: request.params.chain_ref,
            sampleTokenId: mustString(body.sampleTokenId, "sampleTokenId"),
            sourceImageUrl: mustString(body.sourceImageUrl, "sourceImageUrl"),
            sourceImageBytes: optionalPositiveInteger(
                body.sourceImageBytes,
                "sourceImageBytes",
            ),
            imageCacheMode: mustImageCacheMode(body.imageCacheMode),
            maxDimension: optionalPositiveInteger(
                body.maxDimension,
                "maxDimension",
            ),
        };
    }
}

function mustString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new ReadModelBadRequestError(`${field} is required`);
    }
    return value.trim();
}

function optionalPositiveInteger(value: unknown, field: string): number | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new ReadModelBadRequestError(`${field} must be an integer`);
    }
    return value;
}

function mustImageCacheMode(value: unknown): ImageCacheMode {
    if (
        value === IMAGE_CACHE_MODE.Off ||
        value === IMAGE_CACHE_MODE.CacheOnce ||
        value === IMAGE_CACHE_MODE.RefreshOnMetadata
    ) {
        return value;
    }
    throw new ReadModelBadRequestError("imageCacheMode is required");
}
