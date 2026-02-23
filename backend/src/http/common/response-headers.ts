import type { FastifyInstance } from "fastify";

const JSON_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
} as const;

export function registerApiResponseHeaders(app: FastifyInstance): void {
    app.addHook("onSend", async (_request, reply, payload) => {
        for (const [key, value] of Object.entries(JSON_HEADERS)) {
            reply.header(key, value);
        }
        return payload;
    });
}
