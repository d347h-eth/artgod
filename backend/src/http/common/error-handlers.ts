import type { FastifyInstance } from "fastify";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import { logger } from "@artgod/shared/utils";
import { toErrorMessage } from "../../utils/error-message.js";

export function registerApiErrorHandlers(app: FastifyInstance): void {
    app.setNotFoundHandler((_request, reply) => {
        reply.code(404).send({
            error: "not_found",
            message: "Route not found",
        });
    });

    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ReadModelBadRequestError) {
            reply.code(400).send({
                error: "bad_request",
                message: toErrorMessage(error),
            });
            return;
        }

        if (error instanceof ReadModelNotFoundError) {
            reply.code(404).send({
                error: "not_found",
                message: toErrorMessage(error),
            });
            return;
        }

        logger.error("Backend request failed", {
            component: "BackendApi",
            action: "handleRequest",
            path: request.url,
            error: String(error),
        });

        reply.code(500).send({
            error: "internal_error",
            message: "Internal server error",
        });
    });
}
