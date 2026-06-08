import type { FastifyRequest } from "fastify";
import {
    COLLECTION_CUSTOMIZATION_SOURCE_KIND,
    normalizeTraitFilterPresentationConfig,
    normalizeTraitSummaryTemplateConfig,
    type CollectionCustomizationSourceKind,
} from "@artgod/shared/types";
import {
    BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
    BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION,
} from "@artgod/shared/config/bootstrap";
import {
    IMAGE_CACHE_MODE,
    type ImageCacheMode,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    UpdateCollectionCustomizationInput,
    UpdateCollectionCustomizationOutput,
} from "../../../application/use-cases/collections/update-collection-customization.js";

export type UpdateCollectionCustomizationRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Body: {
        traitFilterPresentation?: {
            selectedSource?: unknown;
            userConfig?: {
                rangeKeys?: unknown;
            };
        };
        tokenCardTraitSummaryTemplate?: {
            selectedSource?: unknown;
            userConfig?: {
                template?: unknown;
            };
        };
        activityRowTraitSummaryTemplate?: {
            selectedSource?: unknown;
            userConfig?: {
                template?: unknown;
            };
        };
        imageCachePolicy?: {
            selectedSource?: unknown;
            userConfig?: {
                imageCacheMode?: unknown;
                maxDimension?: unknown;
            };
        };
    };
};

type MaybePromise<T> = T | Promise<T>;

export class UpdateCollectionCustomizationHttpAdapter {
    constructor(
        readonly updateCollectionCustomizationPort: {
            updateCollectionCustomization(
                input: UpdateCollectionCustomizationInput,
            ): MaybePromise<UpdateCollectionCustomizationOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<UpdateCollectionCustomizationRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return await this.updateCollectionCustomizationPort.updateCollectionCustomization(
            input,
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<UpdateCollectionCustomizationRoute>,
    ): UpdateCollectionCustomizationInput {
        const traitFilterPresentation = request.body?.traitFilterPresentation;
        if (!traitFilterPresentation || typeof traitFilterPresentation !== "object") {
            throw new ReadModelBadRequestError(
                "traitFilterPresentation is required",
            );
        }
        const tokenCardTraitSummaryTemplate =
            request.body?.tokenCardTraitSummaryTemplate;
        if (
            !tokenCardTraitSummaryTemplate ||
            typeof tokenCardTraitSummaryTemplate !== "object"
        ) {
            throw new ReadModelBadRequestError(
                "tokenCardTraitSummaryTemplate is required",
            );
        }
        const activityRowTraitSummaryTemplate =
            request.body?.activityRowTraitSummaryTemplate;
        if (
            !activityRowTraitSummaryTemplate ||
            typeof activityRowTraitSummaryTemplate !== "object"
        ) {
            throw new ReadModelBadRequestError(
                "activityRowTraitSummaryTemplate is required",
            );
        }
        const imageCachePolicy = request.body?.imageCachePolicy;
        if (!imageCachePolicy || typeof imageCachePolicy !== "object") {
            throw new ReadModelBadRequestError("imageCachePolicy is required");
        }

        const selectedSource = parseSelectedSource(
            traitFilterPresentation.selectedSource,
            "traitFilterPresentation.selectedSource",
        );
        const userConfig = normalizeTraitFilterPresentationConfig({
            rangeKeys: parseStringList(
                traitFilterPresentation.userConfig?.rangeKeys,
                "traitFilterPresentation.userConfig.rangeKeys",
            ),
        });
        const tokenCardSelectedSource = parseSelectedSource(
            tokenCardTraitSummaryTemplate.selectedSource,
            "tokenCardTraitSummaryTemplate.selectedSource",
        );
        const tokenCardUserConfig = normalizeTraitSummaryTemplateConfig({
            template: parseStringValue(
                tokenCardTraitSummaryTemplate.userConfig?.template,
                "tokenCardTraitSummaryTemplate.userConfig.template",
            ),
        });
        const activitySelectedSource = parseSelectedSource(
            activityRowTraitSummaryTemplate.selectedSource,
            "activityRowTraitSummaryTemplate.selectedSource",
        );
        const activityUserConfig = normalizeTraitSummaryTemplateConfig({
            template: parseStringValue(
                activityRowTraitSummaryTemplate.userConfig?.template,
                "activityRowTraitSummaryTemplate.userConfig.template",
            ),
        });
        const imageCacheSelectedSource = parseSelectedSource(
            imageCachePolicy.selectedSource,
            "imageCachePolicy.selectedSource",
        );
        const imageCacheUserConfig = parseImageCachePolicyConfig(
            imageCachePolicy.userConfig,
        );

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            traitFilterPresentation: {
                selectedSource,
                userConfig,
            },
            tokenCardTraitSummaryTemplate: {
                selectedSource: tokenCardSelectedSource,
                userConfig: tokenCardUserConfig,
            },
            activityRowTraitSummaryTemplate: {
                selectedSource: activitySelectedSource,
                userConfig: activityUserConfig,
            },
            imageCachePolicy: {
                selectedSource: imageCacheSelectedSource,
                userConfig: imageCacheUserConfig,
            },
        };
    }
}

function parseSelectedSource(
    value: unknown,
    field: string,
): CollectionCustomizationSourceKind {
    if (
        value === COLLECTION_CUSTOMIZATION_SOURCE_KIND.User ||
        value === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension
    ) {
        return value;
    }
    throw new ReadModelBadRequestError(`${field} is invalid`);
}

function parseStringList(value: unknown, field: string): string[] {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new ReadModelBadRequestError(`${field} must be an array`);
    }

    return value.map((item) => {
        if (typeof item !== "string") {
            throw new ReadModelBadRequestError(`${field} must contain strings`);
        }
        return item;
    });
}

function parseStringValue(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError(`${field} must be a string`);
    }
    return value;
}

function parseImageCachePolicyConfig(value: unknown): ImageCachePolicyConfig {
    if (!value || typeof value !== "object") {
        throw new ReadModelBadRequestError(
            "imageCachePolicy.userConfig must be an object",
        );
    }
    const source = value as {
        imageCacheMode?: unknown;
        maxDimension?: unknown;
    };
    const imageCacheMode = parseImageCacheMode(source.imageCacheMode);
    if (imageCacheMode === IMAGE_CACHE_MODE.Off) {
        if (source.maxDimension !== undefined && source.maxDimension !== null) {
            throw new ReadModelBadRequestError(
                "imageCachePolicy.userConfig.maxDimension must be null when image cache mode is off",
            );
        }
        return {
            imageCacheMode,
            maxDimension: null,
        };
    }
    if (source.maxDimension === null) {
        return {
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
            "imageCachePolicy.userConfig.maxDimension is invalid",
        );
    }
    return {
        imageCacheMode,
        maxDimension: Number(source.maxDimension),
    };
}

function parseImageCacheMode(value: unknown): ImageCacheMode {
    if (
        value === IMAGE_CACHE_MODE.Off ||
        value === IMAGE_CACHE_MODE.CacheOnce ||
        value === IMAGE_CACHE_MODE.RefreshOnMetadata
    ) {
        return value;
    }
    throw new ReadModelBadRequestError(
        "imageCachePolicy.userConfig.imageCacheMode is invalid",
    );
}
