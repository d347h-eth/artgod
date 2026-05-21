import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX } from "@artgod/shared/media/token-image-cache";

const CONTENT_TYPE_BY_EXT = new Map<string, string>([
    [".gif", "image/gif"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".png", "image/png"],
    [".svg", "image/svg+xml"],
    [".webp", "image/webp"],
]);

// Serves locally cached token images without exposing arbitrary filesystem paths.
export function registerTokenImageCacheStaticRoutes(
    app: FastifyInstance,
    tokenImageCacheDir: string,
): void {
    const cacheDir = path.resolve(tokenImageCacheDir);
    const routePrefix = `${TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX}/*`;

    app.get(routePrefix, async (request, reply) => {
        const relativePath = normalizeCachePath(request);
        if (!relativePath) {
            return reply.code(404).send({ error: "media not found" });
        }

        const target = resolveCachePath(cacheDir, relativePath);
        if (!target) {
            return reply.code(404).send({ error: "media not found" });
        }

        return sendFile(target, reply);
    });
}

function normalizeCachePath(request: FastifyRequest): string | null {
    const rawUrl = request.raw.url ?? "";
    const pathname = rawUrl.split("?")[0] ?? "";
    const prefix = `${TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX}/`;
    if (!pathname.startsWith(prefix)) {
        return null;
    }

    const relativePath = pathname.slice(prefix.length);
    if (!relativePath || relativePath.includes("\0")) {
        return null;
    }
    try {
        return relativePath
            .split("/")
            .filter(Boolean)
            .map((segment) => decodeURIComponent(segment))
            .join(path.sep);
    } catch {
        return null;
    }
}

function resolveCachePath(cacheDir: string, relativePath: string): string | null {
    const resolved = path.resolve(cacheDir, relativePath);
    if (!resolved.startsWith(`${cacheDir}${path.sep}`)) {
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
