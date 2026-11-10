import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { RUNTIME_READY_MESSAGE } from "../../../../shared/runtime/readiness.ts";

export const RUNTIME_EXIT_FIXTURE_ENV = "ARTGOD_SIMULATION_EXIT_FIXTURE_GATE";
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    const gate = process.env[RUNTIME_EXIT_FIXTURE_ENV];
    if (!gate) throw new Error("A test-owned exit gate is required");
    process.stdout.write(
        `${JSON.stringify({ level: "info", msg: RUNTIME_READY_MESSAGE.DomainWorker })}\n`,
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (
            await readFile(gate, "utf8").then(
                (value) => value === "exit",
                () => false,
            )
        )
            process.exit(17);
        await delay(5);
    }
    process.exit(18);
}
