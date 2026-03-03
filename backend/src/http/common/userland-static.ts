import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CONTENT_TYPE_BY_EXT = new Map<string, string>([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".webp", "image/webp"],
    [".ico", "image/x-icon"],
    [".woff", "font/woff"],
    [".woff2", "font/woff2"],
    [".txt", "text/plain; charset=utf-8"],
]);

export function registerUserlandStaticRoutes(
    app: FastifyInstance,
    userlandDistDir: string,
): void {
    const distDir = path.resolve(userlandDistDir);
    const indexPath = path.join(distDir, "index.html");
    if (!existsSync(distDir) || !existsSync(indexPath)) {
        throw new Error(
            `USERLAND_UI_DIST_DIR is missing static assets at ${distDir}`,
        );
    }

    app.get("/", async (_request, reply) => {
        return sendFile(indexPath, reply);
    });

    app.get("/*", async (request, reply) => {
        const pathname = normalizePathname(request);
        if (isApiOrHealthPath(pathname)) {
            return reply.callNotFound();
        }

        const target = resolveStaticPath(distDir, pathname);
        if (target) {
            return sendFile(target, reply);
        }
        return sendFile(indexPath, reply);
    });
}

function normalizePathname(request: FastifyRequest): string {
    const rawUrl = request.raw.url ?? "/";
    const withoutQuery = rawUrl.split("?")[0] ?? "/";
    return withoutQuery || "/";
}

function isApiOrHealthPath(pathname: string): boolean {
    return (
        pathname === "/api" ||
        pathname.startsWith("/api/") ||
        pathname === "/health" ||
        pathname.startsWith("/health/")
    );
}

function resolveStaticPath(distDir: string, pathname: string): string | null {
    if (!pathname.startsWith("/")) {
        return null;
    }
    const relativePath = pathname.slice(1);
    if (!relativePath || relativePath.includes("\0")) {
        return null;
    }
    const resolved = path.resolve(distDir, relativePath);
    if (!resolved.startsWith(distDir)) {
        return null;
    }
    if (!existsSync(resolved)) {
        return null;
    }
    let stats;
    try {
        stats = statSync(resolved);
    } catch {
        return null;
    }
    if (!stats.isFile()) {
        return null;
    }
    return resolved;
}

function sendFile(filePath: string, reply: FastifyReply) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
        CONTENT_TYPE_BY_EXT.get(ext) || "application/octet-stream";
    const payload = readFileSync(filePath);
    return reply.type(contentType).send(payload);
}
