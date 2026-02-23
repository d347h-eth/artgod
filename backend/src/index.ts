import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    SqliteChainsReadModel,
    SqliteCollectionsReadModel,
} from "@artgod/shared/read-models";
import { logger } from "@artgod/shared/utils";
import { GetDefaultChainUseCase } from "./application/use-cases/chains/get-default-chain.js";
import { GetCollectionDetailUseCase } from "./application/use-cases/collections/get-collection-detail.js";
import { ListCollectionsUseCase } from "./application/use-cases/collections/list-collections.js";
import type { BackendConfig } from "./config.js";
import { loadBackendConfig } from "./config.js";
import { createApiApp } from "./http-app.js";

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
    const chainsReadModel = new SqliteChainsReadModel();
    const collectionsReadModel = new SqliteCollectionsReadModel();
    const getDefaultChainUseCase = new GetDefaultChainUseCase(
        defaultChainId,
        chainsReadModel,
    );
    const listCollectionsUseCase = new ListCollectionsUseCase(
        defaultChainId,
        chainsReadModel,
        collectionsReadModel,
    );
    const getCollectionDetailUseCase = new GetCollectionDetailUseCase(
        defaultChainId,
        chainsReadModel,
        collectionsReadModel,
    );

    return createApiApp(
        getDefaultChainUseCase,
        listCollectionsUseCase,
        getCollectionDetailUseCase,
    );
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
