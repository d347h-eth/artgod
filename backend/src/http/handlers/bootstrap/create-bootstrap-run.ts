import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    CreateBootstrapRunInput,
    CreateBootstrapRunOutput,
} from "../../../application/use-cases/bootstrap/types.js";
import {
    BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
    BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION,
} from "@artgod/shared/config/bootstrap";
import {
    IMAGE_CACHE_MODE,
    type ImageCacheMode,
} from "@artgod/shared/media/token-image-cache";
import {
    COLLECTION_CUSTOMIZATION_SOURCE_KIND,
    type CollectionCustomizationSourceKind,
} from "@artgod/shared/types";

export type CreateBootstrapRunRoute = {
    Params: {
        chain_ref: string;
    };
    Body: {
        slug?: string;
        address?: string;
        openseaSlug?: string;
        standard?: string;
        metadataMode?: string;
        supportsEnumerable?: boolean;
        manualInput?: {
            mode?: string;
            tokenIds?: unknown;
            startTokenId?: unknown;
            totalSupply?: unknown;
        };
        imageCache?: {
            selectedSource?: unknown;
            imageCacheMode?: unknown;
            maxDimension?: unknown;
        };
        deploymentBlock?: number;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class CreateBootstrapRunHttpAdapter {
    constructor(
        private readonly createBootstrapRunPort: {
            createRun(
                input: CreateBootstrapRunInput,
            ): MaybePromise<CreateBootstrapRunOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<CreateBootstrapRunRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output = await this.createBootstrapRunPort.createRun(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<CreateBootstrapRunRoute>,
    ): CreateBootstrapRunInput {
        const body = request.body ?? {};
        const slug = mustString(body.slug, "slug");
        const address = mustString(body.address, "address");
        const openseaSlug = optionalString(body.openseaSlug);
        const standard = mustString(body.standard, "standard");
        const metadataMode = mustString(body.metadataMode, "metadataMode");
        const supportsEnumerable = body.supportsEnumerable;
        if (typeof supportsEnumerable !== "boolean") {
            throw new ReadModelBadRequestError(
                "supportsEnumerable must be boolean",
            );
        }

        const manualInput = parseManualInput(body.manualInput);
        const imageCache = parseImageCacheInput(body.imageCache);
        const deploymentBlock = parseOptionalPositiveInteger(
            body.deploymentBlock,
            "deploymentBlock",
        );

        return {
            chainRef: request.params.chain_ref,
            slug,
            address,
            openseaSlug: openseaSlug ?? undefined,
            standard: standard as "erc721",
            metadataMode: metadataMode as "strict" | "best_effort",
            supportsEnumerable,
            manualInput,
            imageCache,
            deploymentBlock: deploymentBlock ?? undefined,
        };
    }

    private mapOutputToResponse(
        output: CreateBootstrapRunOutput,
    ): CreateBootstrapRunOutput {
        return output;
    }
}

function mustString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new ReadModelBadRequestError(`${field} is required`);
    }
    return value.trim();
}

function optionalString(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError("Expected string");
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function parseOptionalPositiveInteger(
    value: unknown,
    field: string,
): number | null {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || Number(value) <= 0) {
        throw new ReadModelBadRequestError(
            `${field} must be a positive integer`,
        );
    }
    return Number(value);
}

function parseImageCacheInput(
    value: unknown,
): CreateBootstrapRunInput["imageCache"] {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!value || typeof value !== "object") {
        throw new ReadModelBadRequestError("imageCache must be an object");
    }
    const source = value as {
        selectedSource?: unknown;
        imageCacheMode?: unknown;
        maxDimension?: unknown;
    };
    const selectedSource = parseImageCacheSelectedSource(
        source.selectedSource,
    );
    const imageCacheMode = parseImageCacheMode(source.imageCacheMode);
    if (imageCacheMode === IMAGE_CACHE_MODE.Off) {
        if (source.maxDimension !== undefined && source.maxDimension !== null) {
            throw new ReadModelBadRequestError(
                "imageCache.maxDimension must be null when image cache mode is off",
            );
        }
        return {
            selectedSource,
            imageCacheMode,
            maxDimension: null,
        };
    }
    if (source.maxDimension === null) {
        return {
            selectedSource,
            imageCacheMode,
            maxDimension: null,
        };
    }
    if (
        !Number.isInteger(source.maxDimension) ||
        Number(source.maxDimension) < BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION ||
        Number(source.maxDimension) > BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION
    ) {
        throw new ReadModelBadRequestError(
            "imageCache.maxDimension is invalid",
        );
    }
    return {
        selectedSource,
        imageCacheMode,
        maxDimension: Number(source.maxDimension),
    };
}

function parseImageCacheSelectedSource(
    value: unknown,
): CollectionCustomizationSourceKind {
    if (value === undefined || value === null) {
        return COLLECTION_CUSTOMIZATION_SOURCE_KIND.User;
    }
    if (
        value === COLLECTION_CUSTOMIZATION_SOURCE_KIND.User ||
        value === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension
    ) {
        return value;
    }
    throw new ReadModelBadRequestError("imageCache.selectedSource is invalid");
}

function parseImageCacheMode(value: unknown): ImageCacheMode {
    if (
        value === IMAGE_CACHE_MODE.Off ||
        value === IMAGE_CACHE_MODE.CacheOnce ||
        value === IMAGE_CACHE_MODE.RefreshOnMetadata
    ) {
        return value;
    }
    throw new ReadModelBadRequestError("imageCache.imageCacheMode is invalid");
}

function parseManualInput(
    value: unknown,
): CreateBootstrapRunInput["manualInput"] {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!value || typeof value !== "object") {
        throw new ReadModelBadRequestError("manualInput must be an object");
    }
    const source = value as {
        mode?: unknown;
        tokenIds?: unknown;
        startTokenId?: unknown;
        totalSupply?: unknown;
    };
    if (source.mode === "manual_token_ids") {
        if (!Array.isArray(source.tokenIds)) {
            throw new ReadModelBadRequestError(
                "manualInput.tokenIds must be an array",
            );
        }
        const tokenIds = source.tokenIds.map((tokenId) => {
            if (typeof tokenId !== "string" || !tokenId.trim()) {
                throw new ReadModelBadRequestError(
                    "manualInput.tokenIds contains invalid token id",
                );
            }
            return tokenId.trim();
        });
        return {
            mode: "manual_token_ids",
            tokenIds,
        };
    }
    if (source.mode === "manual_range") {
        if (
            typeof source.startTokenId !== "string" ||
            !source.startTokenId.trim()
        ) {
            throw new ReadModelBadRequestError(
                "manualInput.startTokenId is required",
            );
        }
        if (
            !Number.isInteger(source.totalSupply) ||
            Number(source.totalSupply) <= 0
        ) {
            throw new ReadModelBadRequestError(
                "manualInput.totalSupply must be a positive integer",
            );
        }
        return {
            mode: "manual_range",
            startTokenId: source.startTokenId.trim(),
            totalSupply: Number(source.totalSupply),
        };
    }
    throw new ReadModelBadRequestError("Invalid manualInput.mode");
}
