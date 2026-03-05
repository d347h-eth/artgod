import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    SqliteChainsReadModel,
    SqliteCollectionsReadModel,
} from "@artgod/shared/read-models";
import { CreateBootstrapRunUseCase } from "./application/use-cases/bootstrap/create-bootstrap-run.js";
import { GetBootstrapRunDetailUseCase } from "./application/use-cases/bootstrap/get-bootstrap-run-detail.js";
import { GetBootstrapStatusUseCase } from "./application/use-cases/bootstrap/get-bootstrap-status.js";
import { ListBootstrapRunsUseCase } from "./application/use-cases/bootstrap/list-bootstrap-runs.js";
import { RetryBootstrapRunFailedTasksUseCase } from "./application/use-cases/bootstrap/retry-bootstrap-run-failed-tasks.js";
import { logger } from "@artgod/shared/utils";
import { GetDefaultChainUseCase } from "./application/use-cases/chains/get-default-chain.js";
import { GetCollectionDetailUseCase } from "./application/use-cases/collections/get-collection-detail.js";
import { ListCollectionsUseCase } from "./application/use-cases/collections/list-collections.js";
import { GetRuntimeHealthUseCase } from "./application/use-cases/health/get-runtime-health.js";
import type { BackendConfig } from "./config.js";
import { loadBackendConfig } from "./config.js";
import { createApiApp } from "./http-app.js";
import { NatsBootstrapCommandQueue } from "./infra/bootstrap/nats-bootstrap-command-queue.js";
import { SqliteBootstrapRunsRepository } from "./infra/bootstrap/sqlite-bootstrap-runs.js";
import { NatsRuntimeHealthAdapter } from "./infra/runtime-health/nats-runtime-health.js";
import { SqliteRuntimeHealthAdapter } from "./infra/runtime-health/sqlite-runtime-health.js";

export async function startBackendServer(
    config: BackendConfig,
): Promise<FastifyInstance> {
    setDbPath(config.dbPath);
    const migrationRunner = createMigrationRunner();
    await migrationRunner.runMigrations();

    const app = createBackendApp(config);
    await app.listen({
        port: config.port,
        host: "127.0.0.1",
    });
    return app;
}

export function createBackendApp(config: BackendConfig): FastifyInstance {
    const chainsReadModel = new SqliteChainsReadModel();
    const collectionsReadModel = new SqliteCollectionsReadModel();
    const bootstrapRunsRepository = new SqliteBootstrapRunsRepository();
    const bootstrapCommandQueue = new NatsBootstrapCommandQueue(
        config.natsUrl,
        config.natsStreamPrefix,
    );
    const createBootstrapRunUseCase = new CreateBootstrapRunUseCase(
        config.defaultChainId,
        chainsReadModel,
        bootstrapRunsRepository,
        bootstrapCommandQueue,
    );
    const getBootstrapStatusUseCase = new GetBootstrapStatusUseCase(
        config.defaultChainId,
        chainsReadModel,
        bootstrapRunsRepository,
    );
    const listBootstrapRunsUseCase = new ListBootstrapRunsUseCase(
        config.defaultChainId,
        chainsReadModel,
        bootstrapRunsRepository,
    );
    const getBootstrapRunDetailUseCase = new GetBootstrapRunDetailUseCase(
        config.defaultChainId,
        chainsReadModel,
        bootstrapRunsRepository,
    );
    const retryBootstrapRunFailedTasksUseCase =
        new RetryBootstrapRunFailedTasksUseCase(
            config.defaultChainId,
            chainsReadModel,
            bootstrapRunsRepository,
            bootstrapCommandQueue,
        );
    const getDefaultChainUseCase = new GetDefaultChainUseCase(
        config.defaultChainId,
        chainsReadModel,
    );
    const listCollectionsUseCase = new ListCollectionsUseCase(
        config.defaultChainId,
        chainsReadModel,
        collectionsReadModel,
    );
    const getCollectionDetailUseCase = new GetCollectionDetailUseCase(
        config.defaultChainId,
        chainsReadModel,
        collectionsReadModel,
    );
    const runtimeHealthUseCase = new GetRuntimeHealthUseCase(
        new SqliteRuntimeHealthAdapter(),
        new NatsRuntimeHealthAdapter(config.natsUrl),
        `${config.natsStreamPrefix}-jobs`,
    );

    return createApiApp(
        createBootstrapRunUseCase,
        listBootstrapRunsUseCase,
        getBootstrapRunDetailUseCase,
        getBootstrapStatusUseCase,
        retryBootstrapRunFailedTasksUseCase,
        getDefaultChainUseCase,
        listCollectionsUseCase,
        getCollectionDetailUseCase,
        runtimeHealthUseCase,
        config.userlandUiDistDir,
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
