import type { FastifyInstance } from "fastify";
import type { BackendSecurityConfig } from "../../config.js";
import {
    createApiOriginPolicy,
    normalizeOrigin,
} from "./origin-policy.js";

export function registerApiResponseHeaders(
    app: FastifyInstance,
    config: BackendSecurityConfig,
): void {
    const policy = createApiOriginPolicy(config);

    app.addHook("onSend", async (request, reply, payload) => {
        const origin = normalizeOrigin(
            typeof request.headers.origin === "string"
                ? request.headers.origin
                : undefined,
        );
        if (origin && policy.allowedOrigins.has(origin)) {
            reply.header("Access-Control-Allow-Origin", origin);
            reply.header("Access-Control-Allow-Credentials", "true");
            reply.header("Vary", "Origin");
        }
        reply.header(
            "Access-Control-Allow-Methods",
            "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        );
        reply.header(
            "Access-Control-Allow-Headers",
            "Content-Type,X-ArtGod-CSRF",
        );
        return payload;
    });
}
