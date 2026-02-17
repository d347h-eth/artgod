import http from "node:http";
import { pathToFileURL } from "node:url";
import { setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    SqliteChainsReadModel,
    SqliteCollectionsReadModel,
} from "@artgod/shared/read-models";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import { DEFAULT_PAGE_LIMIT } from "@artgod/shared/config/pagination";
import type { TraitFilter } from "@artgod/shared/types/browse";
import { logger } from "@artgod/shared/utils";
import type { BackendConfig } from "./config.js";
import { loadBackendConfig } from "./config.js";
import type { ChainsReadPort, CollectionsReadPort } from "./ports/read-models.js";

const JSON_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
} as const;

const ALLOWED_COLLECTION_STATUSES = new Set([
    "bootstrapping",
    "live",
    "paused",
    "disabled",
]);

export type ApiRouteDependencies = {
    defaultChainId: number;
    chainsReadModel: ChainsReadPort;
    collectionsReadModel: CollectionsReadPort;
};

export type ApiRouteResponse = {
    statusCode: number;
    payload: unknown;
};

export async function startBackendServer(
    config: BackendConfig,
): Promise<http.Server> {
    setDbPath(config.dbPath);
    const migrationRunner = createMigrationRunner();
    await migrationRunner.runMigrations();

    const server = createBackendServer(config.defaultChainId);
    await listen(server, config.port);
    return server;
}

export function createBackendServer(defaultChainId: number): http.Server {
    const dependencies = buildApiRouteDependencies(defaultChainId);

    return http.createServer(async (req, res) => {
        try {
            await handleRequest(req, res, dependencies);
        } catch (error) {
            logger.error("Backend request failed", {
                component: "BackendApi",
                action: "handleRequest",
                error: String(error),
            });
            sendJson(res, 500, {
                error: "internal_error",
                message: "Internal server error",
            });
        }
    });
}

function buildApiRouteDependencies(defaultChainId: number): ApiRouteDependencies {
    const chainsReadModel: ChainsReadPort = new SqliteChainsReadModel();
    const collectionsReadModel: CollectionsReadPort =
        new SqliteCollectionsReadModel();

    return {
        defaultChainId,
        chainsReadModel,
        collectionsReadModel,
    };
}

function listen(server: http.Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
}

async function main() {
    const config = loadBackendConfig(process.env);
    const server = await startBackendServer(config);

    logger.info("Backend API ready", {
        component: "BackendApi",
        action: "startup",
        port: config.port,
        defaultChainId: config.defaultChainId,
    });

    const shutdown = () => {
        logger.info("Backend API shutting down", {
            component: "BackendApi",
            action: "shutdown",
        });
        server.close();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    dependencies: ApiRouteDependencies,
): Promise<void> {
    const url = new URL(req.url ?? "/", getRequestOrigin(req));
    const result = resolveApiRequest(req.method, url, dependencies);

    if (result.statusCode === 204) {
        sendEmpty(res, 204);
        return;
    }

    sendJson(res, result.statusCode, result.payload);
}

export function resolveApiRequest(
    method: string | undefined,
    url: URL,
    dependencies: ApiRouteDependencies,
): ApiRouteResponse {
    try {
        if (method === "OPTIONS") {
            return { statusCode: 204, payload: null };
        }

        if (method !== "GET") {
            return {
                statusCode: 405,
                payload: {
                    error: "method_not_allowed",
                    message: "Only GET is supported",
                },
            };
        }

        const path = url.pathname.replace(/\/+$/, "") || "/";
        const segments = path.split("/").filter(Boolean);
        if (segments[0] !== "api") {
            return notFoundRouteResponse();
        }

        if (
            segments.length === 3 &&
            segments[1] === "chains" &&
            segments[2] === "default"
        ) {
            const chain = dependencies.chainsReadModel.getDefaultChain(
                dependencies.defaultChainId,
            );
            return {
                statusCode: 200,
                payload: { chain },
            };
        }

        if (segments.length === 3 && segments[2] === "collections") {
            return {
                statusCode: 200,
                payload: buildCollectionsListPayload(
                    url,
                    dependencies.defaultChainId,
                    dependencies.chainsReadModel,
                    dependencies.collectionsReadModel,
                    segments[1]!,
                ),
            };
        }

        if (segments.length === 3) {
            return {
                statusCode: 200,
                payload: buildCollectionDetailPayload(
                    url,
                    dependencies.defaultChainId,
                    dependencies.chainsReadModel,
                    dependencies.collectionsReadModel,
                    segments[1]!,
                    segments[2]!,
                ),
            };
        }

        return notFoundRouteResponse();
    } catch (error) {
        if (error instanceof ReadModelBadRequestError) {
            return {
                statusCode: 400,
                payload: {
                    error: "bad_request",
                    message: toErrorMessage(error),
                },
            };
        }
        if (error instanceof ReadModelNotFoundError) {
            return {
                statusCode: 404,
                payload: {
                    error: "not_found",
                    message: toErrorMessage(error),
                },
            };
        }
        throw error;
    }
}

function buildCollectionsListPayload(
    url: URL,
    defaultChainId: number,
    chainsReadModel: ChainsReadPort,
    collectionsReadModel: CollectionsReadPort,
    chainRef: string,
): unknown {
    const chain = chainsReadModel.resolveChainRef(chainRef, defaultChainId);
    const status = parseStatus(url.searchParams.get("status"));
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = parseCursor(url.searchParams.get("cursor"));

    const page = collectionsReadModel.listCollections({
        chainId: chain.publicChainId,
        status,
        limit,
        cursor: cursor ?? undefined,
    });

    return {
        chain,
        filters: { status },
        page,
    };
}

function buildCollectionDetailPayload(
    url: URL,
    defaultChainId: number,
    chainsReadModel: ChainsReadPort,
    collectionsReadModel: CollectionsReadPort,
    chainRef: string,
    collectionRef: string,
): unknown {
    const chain = chainsReadModel.resolveChainRef(chainRef, defaultChainId);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = parseCursor(url.searchParams.get("cursor"));
    const traits = parseTraits(url.searchParams);

    const collection = collectionsReadModel.resolveCollectionRef(
        chain.publicChainId,
        collectionRef,
    );

    const tokens = collectionsReadModel.listCollectionTokens({
        chainId: chain.publicChainId,
        contractAddress: collection.address,
        limit,
        cursor: cursor ?? undefined,
        traitFilters: traits,
    });

    const facets = collectionsReadModel.listCollectionTraitFacets(
        chain.publicChainId,
        collection.address,
    );

    return {
        chain,
        collection,
        traits: {
            selected: traits,
            facets,
        },
        tokens,
    };
}

function notFoundRouteResponse(): ApiRouteResponse {
    return {
        statusCode: 404,
        payload: {
            error: "not_found",
            message: "Route not found",
        },
    };
}

function parseStatus(
    raw: string | null,
): "bootstrapping" | "live" | "paused" | "disabled" | undefined {
    if (!raw || !raw.trim()) return undefined;
    if (!ALLOWED_COLLECTION_STATUSES.has(raw)) {
        throw new ReadModelBadRequestError("Invalid status");
    }
    return raw as "bootstrapping" | "live" | "paused" | "disabled";
}

function parseLimit(raw: string | null): number {
    if (!raw || !raw.trim()) return DEFAULT_PAGE_LIMIT;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ReadModelBadRequestError("Invalid limit");
    }
    return parsed;
}

function parseCursor(raw: string | null): string | null {
    if (!raw || !raw.trim()) return null;
    return raw.trim();
}

function parseTraits(searchParams: URLSearchParams): TraitFilter[] {
    const values = [
        ...searchParams.getAll("traits"),
        ...searchParams.getAll("trait"),
    ];
    if (values.length === 0) return [];

    const parsed: TraitFilter[] = [];
    for (const value of values) {
        for (const segment of value.split(",")) {
            const trimmed = segment.trim();
            if (!trimmed) continue;
            const delimiter = trimmed.indexOf(":");
            if (delimiter <= 0 || delimiter === trimmed.length - 1) {
                throw new ReadModelBadRequestError("Invalid trait filter");
            }
            const key = trimmed.slice(0, delimiter).trim();
            const traitValue = trimmed.slice(delimiter + 1).trim();
            if (!key || !traitValue) {
                throw new ReadModelBadRequestError("Invalid trait filter");
            }
            parsed.push({ key, value: traitValue });
        }
    }
    return parsed;
}

function getRequestOrigin(req: http.IncomingMessage): string {
    const host = req.headers.host ?? "127.0.0.1:3000";
    return `http://${host}`;
}

function sendJson(
    res: http.ServerResponse,
    statusCode: number,
    payload: unknown,
): void {
    res.writeHead(statusCode, JSON_HEADERS);
    res.end(JSON.stringify(payload));
}

function sendEmpty(res: http.ServerResponse, statusCode: number): void {
    res.writeHead(statusCode, JSON_HEADERS);
    res.end();
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

if (isEntrypoint()) {
    main().catch((error) => {
        logger.error("Backend startup failed", {
            component: "BackendApi",
            action: "startup",
            error: String(error),
        });
        process.exit(1);
    });
}

function isEntrypoint(): boolean {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
}
