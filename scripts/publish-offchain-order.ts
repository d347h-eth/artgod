import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../indexer/src/config/index.js";
import { NatsJetStreamQueue } from "../indexer/src/infra/queue/nats.js";
import { QUEUE_NAMES } from "../indexer/src/domain/queues.js";
import {
    OFFCHAIN_JOB_KIND,
    type OffchainOrderRawPayload,
} from "../indexer/src/domain/offchain-jobs.js";
import type { JobEnvelope } from "../indexer/src/domain/jobs.js";

type Args = {
    file?: string;
    source?: string;
    chainId?: number;
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = loadConfig();
    if (args.chainId !== undefined && !Number.isFinite(args.chainId)) {
        throw new Error("Invalid --chain-id");
    }
    const source = args.source ?? "dev";
    const chainId = args.chainId ?? config.chainId;
    const payload = await loadPayload(args.file);

    const job: JobEnvelope<OffchainOrderRawPayload> = {
        jobId: `offchain:raw:${source}:${chainId}:${Date.now()}`,
        kind: OFFCHAIN_JOB_KIND.OrderRaw,
        queue: QUEUE_NAMES.OffchainOrdersRaw,
        payload: {
            source,
            chainId,
            receivedAt: Date.now(),
            payload,
        },
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
    };

    const queue = await NatsJetStreamQueue.connect({
        natsUrl: config.queue.natsUrl,
        streamPrefix: config.queue.streamPrefix,
    });

    await queue.publish(QUEUE_NAMES.OffchainOrdersRaw, job);
    await queue.close();

    console.log("Offchain raw order published", {
        source,
        chainId,
        jobId: job.jobId,
    });
}

main().catch((error) => {
    console.error("Failed to publish offchain order", String(error));
    process.exit(1);
});

function parseArgs(values: string[]): Args {
    const args: Args = {};
    for (let i = 0; i < values.length; i += 1) {
        const value = values[i];
        if (value === "--file") {
            args.file = values[i + 1];
            i += 1;
            continue;
        }
        if (value === "--source") {
            args.source = values[i + 1];
            i += 1;
            continue;
        }
        if (value === "--chain-id") {
            const raw = values[i + 1];
            if (raw !== undefined) {
                args.chainId = Number(raw);
            }
            i += 1;
        }
    }
    return args;
}

async function loadPayload(file?: string): Promise<unknown> {
    if (file) {
        const resolved = path.resolve(process.cwd(), file);
        const raw = await fs.readFile(resolved, "utf8");
        return JSON.parse(raw) as unknown;
    }

    return {
        orderId: `dev-${Date.now()}`,
        kind: "seaport",
        side: "buy",
        maker: "0x0000000000000000000000000000000000000001",
        taker: null,
        contract: "0x0000000000000000000000000000000000000002",
        tokenId: "1",
        price: "1000000000000000000",
        currency: "0x0000000000000000000000000000000000000000",
        validFrom: Math.floor(Date.now() / 1000),
        validUntil: null,
    };
}
