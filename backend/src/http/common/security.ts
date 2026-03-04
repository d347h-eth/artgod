import { randomUUID } from "node:crypto";
import type {
    FastifyInstance,
    FastifyReply,
    FastifyRequest,
    HookHandlerDoneFunction,
} from "fastify";

const CSRF_COOKIE_NAME = "artgod_csrf";
const CSRF_HEADER_NAME = "x-artgod-csrf";

export function registerApiSecurityHooks(app: FastifyInstance): void {
    app.addHook("onRequest", (request, reply, done) => {
        if (!isMutatingApiRequest(request)) {
            done();
            return;
        }

        const host = request.headers.host;
        if (!host || !isAllowedLoopbackHost(host)) {
            rejectForbidden(reply, done, "Invalid host");
            return;
        }

        const origin = request.headers.origin;
        if (!origin || !isAllowedOrigin(origin, host)) {
            rejectForbidden(reply, done, "Invalid origin");
            return;
        }

        const headerToken = request.headers[CSRF_HEADER_NAME];
        if (typeof headerToken !== "string" || !headerToken.trim()) {
            rejectForbidden(reply, done, "Missing CSRF header");
            return;
        }
        const cookieToken = parseCookieToken(
            request.headers.cookie,
            CSRF_COOKIE_NAME,
        );
        if (!cookieToken || cookieToken !== headerToken.trim()) {
            rejectForbidden(reply, done, "Invalid CSRF token");
            return;
        }

        done();
    });
}

export async function issueCsrfToken(
    _request: FastifyRequest,
    reply: FastifyReply,
): Promise<{ token: string }> {
    const token = randomUUID().replace(/-/g, "");
    reply.header(
        "Set-Cookie",
        `${CSRF_COOKIE_NAME}=${token}; Path=/; Max-Age=86400; SameSite=Strict; HttpOnly`,
    );
    return { token };
}

export function isAllowedOrigin(origin: string, host: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }
    if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
        return false;
    }
    const originHostName = extractHostName(parsed.host.toLowerCase());
    const requestHostName = extractHostName(host.toLowerCase());
    return (
        isAllowedLoopbackName(originHostName) &&
        isAllowedLoopbackName(requestHostName)
    );
}

function isMutatingApiRequest(request: FastifyRequest): boolean {
    const method = request.method.toUpperCase();
    if (
        method !== "POST" &&
        method !== "PUT" &&
        method !== "PATCH" &&
        method !== "DELETE"
    ) {
        return false;
    }
    const path = request.raw.url ?? "";
    return path.startsWith("/api/");
}

function isAllowedLoopbackHost(host: string): boolean {
    const value = host.trim().toLowerCase();
    const withoutPort = extractHostName(value);
    return (
        withoutPort === "127.0.0.1" ||
        withoutPort === "localhost" ||
        withoutPort === "::1" ||
        withoutPort === "[::1]"
    );
}

function parseCookieToken(
    cookieHeader: string | undefined,
    key: string,
): string | null {
    if (!cookieHeader) return null;
    const entries = cookieHeader.split(";");
    for (const entry of entries) {
        const [name, ...rest] = entry.trim().split("=");
        if (name !== key) continue;
        const value = rest.join("=").trim();
        return value || null;
    }
    return null;
}

function rejectForbidden(
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
    message: string,
): void {
    reply.code(403).send({
        error: "forbidden",
        message,
    });
    done();
}

function extractHostName(host: string): string {
    if (host.startsWith("[")) {
        const end = host.indexOf("]");
        if (end > 0) {
            return host.slice(1, end);
        }
    }
    const idx = host.indexOf(":");
    if (idx >= 0) {
        return host.slice(0, idx);
    }
    return host;
}

function isAllowedLoopbackName(host: string): boolean {
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
