import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { connect, type NatsConnection } from "nats";
import { DEFAULT_DESKTOP_NATS_VERSION } from "../../../scripts/build/native-runtime-dependencies.mjs";

export async function waitForFixture(
    check: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs = 20_000,
) {
    const start = performance.now();
    while (!(await check())) {
        if (performance.now() - start > timeoutMs)
            throw new Error(`Timed out: ${label}`);
        await delay(20);
    }
}

export async function stopFixtureChild(
    child: ChildProcess,
    signal: NodeJS.Signals = "SIGTERM",
) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
    });
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try {
        await exit;
    } finally {
        clearTimeout(timer);
    }
}

/** Uses an existing pinned binary and a caller-owned synthetic store. */
export class IsolatedNats {
    private constructor(
        readonly child: ChildProcess,
        readonly connection: NatsConnection,
        readonly url: string,
    ) {}

    static async start(binary: string, artifacts: string, store: string) {
        const version = (await promisify(execFile)(binary, ["--version"]))
            .stdout;
        if (!version.includes(DEFAULT_DESKTOP_NATS_VERSION))
            throw new Error(
                "Fixture NATS version differs from project runtime policy",
            );
        await mkdir(store, { recursive: true });
        const probe = createServer();
        await new Promise<void>((resolve, reject) => {
            probe.once("error", reject);
            probe.listen(0, "127.0.0.1", resolve);
        });
        const port = (probe.address() as { port: number }).port;
        await new Promise<void>((resolve, reject) =>
            probe.close((error) => (error ? reject(error) : resolve())),
        );
        const run = await mkdtemp(path.join(artifacts, "broker-"));
        const config = path.join(run, "server.conf");
        await writeFile(
            config,
            `host: "127.0.0.1"\nport: ${port}\njetstream { store_dir: ${JSON.stringify(store)}, max_file_store: 67108864 }\n`,
        );
        const log = await open(path.join(run, "server.log"), "w");
        const child = spawn(binary, ["-c", config], {
            stdio: ["ignore", log.fd, log.fd],
        });
        await log.close();
        const url = `nats://127.0.0.1:${port}`;
        let connection: NatsConnection | undefined;
        try {
            await waitForFixture(
                async () => {
                    if (child.exitCode !== null || child.signalCode !== null)
                        throw new Error(`Fixture broker exited: ${run}`);
                    try {
                        connection = await connect({
                            servers: url,
                            reconnect: false,
                            timeout: 300,
                        });
                        return true;
                    } catch {
                        return false;
                    }
                },
                "broker startup",
                5_000,
            );
            return new IsolatedNats(child, connection!, url);
        } catch (error) {
            await stopFixtureChild(child);
            throw error;
        }
    }

    async stop() {
        await this.connection.close();
        await stopFixtureChild(this.child);
    }
}
