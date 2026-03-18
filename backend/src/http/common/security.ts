import { randomUUID } from "node:crypto";
import type {
    FastifyInstance,
    FastifyReply,
    FastifyRequest,
    HookHandlerDoneFunction,
} from "fastify";
import type { BackendSecurityConfig } from "../../config.js";
import {
    createApiOriginPolicy,
    isAllowedRequestHost,
    isAllowedRequestOrigin,
} from "./origin-policy.js";

const CSRF_COOKIE_NAME = "artgod_csrf";
const CSRF_HEADER_NAME = "x-artgod-csrf";

export function registerApiSecurityHooks(
    app: FastifyInstance,
    config: BackendSecurityConfig,
): void {
    const policy = createApiOriginPolicy(config);

    app.addHook("onRequest", (request, reply, done) => {
        if (!isMutatingApiRequest(request)) {
            done();
            return;
        }

        const host = request.headers.host;
        if (!isAllowedRequestHost(host, policy)) {
            rejectForbidden(reply, done, "Invalid host");
            return;
        }

        const origin = request.headers.origin;
        if (!isAllowedRequestOrigin(origin, policy)) {
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

export function createIssueCsrfTokenHandler(config: BackendSecurityConfig) {
    return async function issueCsrfToken(
        _request: FastifyRequest,
        reply: FastifyReply,
    ): Promise<{ token: string }> {
        const token = randomUUID().replace(/-/g, "");
        const secureCookieSuffix = config.csrfCookieSecure ? "; Secure" : "";
        reply.header(
            "Set-Cookie",
            `${CSRF_COOKIE_NAME}=${token}; Path=/; Max-Age=86400; SameSite=Strict; HttpOnly${secureCookieSuffix}`,
        );
        return { token };
    };
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
