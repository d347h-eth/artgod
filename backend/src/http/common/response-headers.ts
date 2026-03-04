import type { FastifyInstance } from "fastify";

export function registerApiResponseHeaders(app: FastifyInstance): void {
    app.addHook("onSend", async (request, reply, payload) => {
        const origin =
            typeof request.headers.origin === "string"
                ? request.headers.origin.trim()
                : "";
        if (isLoopbackOrigin(origin)) {
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

function isLoopbackOrigin(origin: string): boolean {
    if (!origin) return false;
    try {
        const parsed = new URL(origin);
        return (
            parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "localhost" ||
            parsed.hostname === "::1" ||
            parsed.hostname === "[::1]"
        );
    } catch {
        return false;
    }
}
