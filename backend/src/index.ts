import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    SqliteChainsReadModel,
    SqliteCollectionsReadModel,
} from "@artgod/shared/read-models";
import { logger } from "@artgod/shared/utils";
import type { BackendConfig } from "./config.js";
import { loadBackendConfig } from "./config.js";
import type { ChainsReadPort, CollectionsReadPort } from "./ports/read-models.js";
import {
    createApiApp,
    type ApiRouteDependencies,
} from "./http-app.js";

export async function startBackendServer(
    config: BackendConfig,
): Promise<FastifyInstance> {
    setDbPath(config.dbPath);
    const migrationRunner = createMigrationRunner();
    await migrationRunner.runMigrations();

    const app = createBackendApp(config.defaultChainId);
    await app.listen({
        port: config.port,
        host: "127.0.0.1",
    });
    return app;
}

export function createBackendApp(defaultChainId: number): FastifyInstance {
    return createApiApp(buildApiRouteDependencies(defaultChainId));
}

export function buildApiRouteDependencies(
    defaultChainId: number,
): ApiRouteDependencies {
    const chainsReadModel: ChainsReadPort = new SqliteChainsReadModel();
    const collectionsReadModel: CollectionsReadPort =
        new SqliteCollectionsReadModel();

    return {
        defaultChainId,
        chainsReadModel,
        collectionsReadModel,
    };
}

async function main() {
    const config = loadBackendConfig(process.env);
    const app = await startBackendServer(config);

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
        void app.close();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
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
