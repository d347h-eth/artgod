import type { FastifyInstance } from "fastify";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import {
    BootstrapConflictError,
    BootstrapValidationError,
} from "../../application/use-cases/bootstrap/types.js";
import { PurgeCollectionValidationError } from "../../application/use-cases/collections/purge-collection.js";
import { TradingValidationError } from "../../application/use-cases/trading/types.js";
import { logger } from "@artgod/shared/utils";
import { toErrorMessage } from "../../utils/error-message.js";
import { BootstrapImageCacheEstimateError } from "../../application/use-cases/bootstrap/estimate-bootstrap-image-cache.js";

export function registerApiErrorHandlers(app: FastifyInstance): void {
    app.setNotFoundHandler((_request, reply) => {
        reply.code(404).send({
            error: "not_found",
            message: "Route not found",
        });
    });

    app.setErrorHandler((error, request, reply) => {
        const { statusCode, ...body } = mapApiError(error, request.url);
        reply.code(statusCode).send(body);
    });
}

/** Shared by ordinary responses and terminal errors after streaming headers. */
export function mapApiError(
    error: unknown,
    path: string,
): {
    statusCode: number;
    error: string;
    message: string;
} {
    if (error instanceof BootstrapImageCacheEstimateError) {
        logger.warn("Bootstrap image cache estimate failed", {
            component: "BackendApi",
            action: "estimateImageCache",
            error: String(error.cause),
        });
        return {
            statusCode: 502,
            error: "image_cache_estimate_failed",
            message: error.message,
        };
    }
    if (error instanceof ReadModelBadRequestError) {
        return {
            statusCode: 400,
            error: "bad_request",
            message: toErrorMessage(error),
        };
    }

    if (error instanceof ReadModelNotFoundError) {
        return {
            statusCode: 404,
            error: "not_found",
            message: toErrorMessage(error),
        };
    }

    if (error instanceof BootstrapValidationError) {
        return {
            statusCode: 422,
            error: "validation_error",
            message: toErrorMessage(error),
        };
    }

    if (error instanceof BootstrapConflictError) {
        return {
            statusCode: 409,
            error: "conflict",
            message: toErrorMessage(error),
        };
    }

    if (error instanceof TradingValidationError) {
        return {
            statusCode: 422,
            error: "validation_error",
            message: toErrorMessage(error),
        };
    }

    if (error instanceof PurgeCollectionValidationError) {
        return {
            statusCode: 422,
            error: "validation_error",
            message: toErrorMessage(error),
        };
    }

    logger.error("Backend request failed", {
        component: "BackendApi",
        action: "handleRequest",
        path,
        error: String(error),
    });

    return {
        statusCode: 500,
        error: "internal_error",
        message: "Internal server error",
    };
}
