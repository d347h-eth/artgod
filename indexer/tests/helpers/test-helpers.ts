import { execa } from "execa";
import { GenericContainer, Wait } from "testcontainers";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { promises as fs } from "node:fs";
import { resolveProjectPath } from "@artgod/shared/utils/paths";

export type WorkerProcess = {
    name: string;
    process: ReturnType<typeof execa>;
    stop: () => Promise<void>;
};

export type NatsHandle = {
    url: string;
    stop: () => Promise<void>;
};

export async function startNats(natsPort: number): Promise<NatsHandle> {
    try {
        const containerBuilder = new GenericContainer("nats:2.10.17")
            .withCommand(["-js"])
            .withExposedPorts({ container: 4222, host: natsPort })
            .withWaitStrategy(Wait.forLogMessage("Server is ready"))
            .withStartupTimeout(5000);

        const container = await containerBuilder.start();

        const url = `nats://${container.getHost()}:${container.getMappedPort(4222)}`;
        return {
            url,
            stop: async () => {
                await container.stop();
            },
        };
    } catch (error) {
        throw new Error(
            `Failed to start NATS container. Ensure Docker is running. ${String(error)}`,
        );
    }
}

export async function startWorker(
    name: string,
    script: string,
    env: Record<string, string | undefined>,
    cwd: string,
): Promise<WorkerProcess> {
    const child = execa("yarn", [script], {
        cwd,
        env,
        stdio: "pipe",
    });

    await delay(1000);
    if (child.exitCode !== null) {
        throw new Error(`${name} exited early with code ${child.exitCode}`);
    }

    return {
        name,
        process: child,
        stop: async () => {
            child.kill("SIGTERM");
            await child.catch(() => {});
        },
    };
}

export async function createTempDbPath(): Promise<string> {
    const envPath = process.env.ARTGOD_DB_PATH;
    if (!envPath) {
        throw new Error("Missing ARTGOD_DB_PATH");
    }
    const resolvedBase = path.isAbsolute(envPath)
        ? envPath
        : resolveProjectPath(envPath);
    const resolved = `${resolvedBase}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    return resolved;
}

export async function waitFor(
    predicate: () => boolean,
    timeoutMs = 10_000,
    intervalMs = 500,
): Promise<void> {
    const start = Date.now();
    for (;;) {
        if (predicate()) return;
        if (timeoutMs > 0 && Date.now() - start > timeoutMs) {
            throw new Error("Timed out waiting for condition");
        }
        await delay(intervalMs);
    }
}
