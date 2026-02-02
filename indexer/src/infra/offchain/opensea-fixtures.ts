import fs from "node:fs/promises";
import path from "node:path";
import type {
    OffchainSourceHandler,
    OffchainSourcePort,
} from "../../ports/offchain-source.js";

export type OpenSeaFixtureConfig = {
    fixturesDir: string;
    chainId: number;
    source: string;
    delayMs: number;
};

export class OpenSeaFixtureSource implements OffchainSourcePort {
    private stopped = false;

    constructor(private config: OpenSeaFixtureConfig) {}

    async start(handler: OffchainSourceHandler): Promise<void> {
        const files = await fs.readdir(this.config.fixturesDir);
        const payloadFiles = files
            .filter((file) => file.endsWith(".json"))
            .sort((a, b) => a.localeCompare(b));

        for (const file of payloadFiles) {
            if (this.stopped) break;
            const filePath = path.join(this.config.fixturesDir, file);
            const raw = await fs.readFile(filePath, "utf8");
            const parsed = JSON.parse(raw) as unknown;
            const payload = normalizeFixturePayload(parsed, file);

            await handler({
                source: this.config.source,
                chainId: this.config.chainId,
                receivedAt: Date.now(),
                payload,
                eventId: file,
            });

            if (this.config.delayMs > 0) {
                await sleep(this.config.delayMs);
            }
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
    }
}

function normalizeFixturePayload(payload: unknown, file: string): unknown {
    if (!payload || typeof payload !== "object") return payload;
    const record = payload as Record<string, unknown>;
    if (typeof record.event_type === "string") return payload;

    if (file === "order_invalidation.json") {
        return {
            event_type: "order_invalidation",
            payload: record,
        };
    }
    if (file === "order_revalidation.json") {
        return {
            event_type: "order_revalidation",
            payload: record,
        };
    }

    return payload;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
