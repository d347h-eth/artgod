import dotenv from "dotenv";
import { connect, JSONCodec, type Codec, type NatsConnection } from "nats";
import { getSettingDefault } from "@artgod/shared/config/generated-settings-defaults";
import { parsePositiveInteger } from "@artgod/shared/utils/env";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils";
import {
    summarizeJobBacklog,
    type InspectableJobEnvelope,
} from "../src/application/queue-inspection/job-backlog-summary.js";
import { QUEUE_NAMES, type QueueName } from "../src/domain/queues.js";
import {
    resolveNatsJobStreamName,
    resolveNatsJobSubject,
} from "../src/infra/queue/nats.js";

dotenv.config({ path: resolveRuntimeEnvPath(process.env, ".env") });

type CliArgs = {
    natsUrl?: string;
    streamPrefix?: string;
    stream?: string;
    queue?: string;
    subject?: string;
    startSeq?: number;
    limit?: number;
    top?: number;
    samples?: number;
    help?: boolean;
};

type InspectorConfig = {
    natsUrl: string;
    streamPrefix: string;
    stream: string;
    subject: string;
    startSeq?: number;
    limit: number;
    top: number;
    samples: number;
};

type StreamInfoResponse = {
    state?: {
        messages?: number;
        first_seq?: number;
        last_seq?: number;
    };
    error?: JetStreamApiError;
};

type JetStreamApiError = {
    code: number;
    err_code: number;
    description: string;
};

type MessageGetResponse = {
    message?: {
        subject: string;
        seq: number;
        data: string;
        time: string;
    };
    error?: JetStreamApiError;
};

const DEFAULT_LIMIT = 10_000;
const DEFAULT_TOP = 20;
const DEFAULT_SAMPLES = 3;
const NO_MESSAGE_FOUND = 10037;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    printUsage();
    process.exit(0);
}

const config = loadInspectorConfig(args, process.env);
const summary = await inspectBacklog(config);
console.log(JSON.stringify(summary, null, 2));

async function inspectBacklog(config: InspectorConfig) {
    const codec = JSONCodec<unknown>();
    const nc = await connect({
        servers: config.natsUrl,
        name: "artgod-jetstream-backlog-inspector",
    });

    try {
        // Read stream state first so the scan can start at the first live seq.
        const streamInfo = await requestJson<StreamInfoResponse>(
            codec,
            nc,
            `$JS.API.STREAM.INFO.${config.stream}`,
            {},
        );
        if (streamInfo.error) {
            throw new Error(formatJetStreamError(streamInfo.error));
        }

        const state = streamInfo.state;
        if (!state?.first_seq) {
            throw new Error(`Stream ${config.stream} has no first sequence`);
        }

        const rows: InspectableJobEnvelope[] = [];
        let nextSeq = config.startSeq ?? state.first_seq;

        while (rows.length < config.limit) {
            const response = await requestJson<MessageGetResponse>(
                codec,
                nc,
                `$JS.API.STREAM.MSG.GET.${config.stream}`,
                {
                    seq: nextSeq,
                    next_by_subj: config.subject,
                },
            );
            if (response.error) {
                if (response.error.err_code === NO_MESSAGE_FOUND) {
                    break;
                }
                throw new Error(formatJetStreamError(response.error));
            }
            if (!response.message) {
                break;
            }

            rows.push(decodeStoredJob(response.message));
            nextSeq = response.message.seq + 1;
        }

        return {
            stream: config.stream,
            subject: config.subject,
            scan: {
                startSeq: config.startSeq ?? state.first_seq,
                limit: config.limit,
                streamMessages: state.messages ?? null,
                streamFirstSeq: state.first_seq ?? null,
                streamLastSeq: state.last_seq ?? null,
                scannedMessages: rows.length,
            },
            summary: summarizeJobBacklog(rows, {
                topN: config.top,
                sampleSize: config.samples,
            }),
        };
    } finally {
        await nc.drain();
    }
}

async function requestJson<T>(
    codec: Codec<unknown>,
    nc: NatsConnection,
    subject: string,
    payload: unknown,
): Promise<T> {
    const message = await nc.request(subject, codec.encode(payload), {
        timeout: 5_000,
    });
    return codec.decode(message.data) as T;
}

function decodeStoredJob(message: {
    subject: string;
    seq: number;
    data: string;
    time: string;
}): InspectableJobEnvelope {
    const decoded = JSON.parse(Buffer.from(message.data, "base64").toString());
    if (!isJobObject(decoded)) {
        throw new Error(`Stored message ${message.seq} is not a job envelope`);
    }

    return {
        seq: message.seq,
        time: message.time,
        subject: message.subject,
        jobId: decoded.jobId,
        kind: decoded.kind,
        queue: decoded.queue,
        attempt: decoded.attempt,
        scheduledAt: decoded.scheduledAt,
        chainId: decoded.chainId,
        collectionId:
            typeof decoded.collectionId === "number"
                ? decoded.collectionId
                : null,
        traceId: typeof decoded.traceId === "string" ? decoded.traceId : null,
        payload: decoded.payload,
    };
}

function isJobObject(value: unknown): value is {
    jobId: string;
    kind: string;
    queue: string;
    attempt: number;
    scheduledAt: number;
    chainId: number;
    collectionId?: number;
    traceId?: string;
    payload: Record<string, unknown>;
} {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.jobId === "string" &&
        typeof record.kind === "string" &&
        typeof record.queue === "string" &&
        typeof record.attempt === "number" &&
        typeof record.scheduledAt === "number" &&
        typeof record.chainId === "number" &&
        !!record.payload &&
        typeof record.payload === "object" &&
        !Array.isArray(record.payload)
    );
}

function loadInspectorConfig(
    args: CliArgs,
    env: Record<string, string | undefined>,
): InspectorConfig {
    const streamPrefix =
        args.streamPrefix ??
        env.NATS_STREAM_PREFIX ??
        getSettingDefault("NATS_STREAM_PREFIX");
    const queue = args.queue ?? QUEUE_NAMES.OrdersUpdateByMaker;
    const knownQueue = parseQueueName(queue);
    const stream = args.stream ?? resolveNatsJobStreamName(streamPrefix);
    const subject =
        args.subject ?? resolveNatsJobSubject(streamPrefix, knownQueue);

    return {
        natsUrl: args.natsUrl ?? env.NATS_URL ?? getSettingDefault("NATS_URL"),
        streamPrefix,
        stream,
        subject,
        startSeq: args.startSeq,
        limit:
            args.limit ??
            parsePositiveInteger(
                env.QUEUE_INSPECT_LIMIT,
                "QUEUE_INSPECT_LIMIT",
                DEFAULT_LIMIT,
            ),
        top: args.top ?? DEFAULT_TOP,
        samples: args.samples ?? DEFAULT_SAMPLES,
    };
}

function parseQueueName(queue: string): QueueName {
    if (Object.values(QUEUE_NAMES).includes(queue as QueueName)) {
        return queue as QueueName;
    }
    throw new Error(`Unknown queue name: ${queue}`);
}

function parseArgs(raw: string[]): CliArgs {
    const parsed: CliArgs = {};
    for (let i = 0; i < raw.length; i += 1) {
        const arg = raw[i];
        if (!arg) continue;
        if (arg === "--") {
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            parsed.help = true;
            continue;
        }
        if (arg === "--server" || arg === "--nats-url") {
            parsed.natsUrl = requireValue(raw, i, arg);
            i += 1;
            continue;
        }
        if (arg === "--stream-prefix") {
            parsed.streamPrefix = requireValue(raw, i, arg);
            i += 1;
            continue;
        }
        if (arg === "--stream") {
            parsed.stream = requireValue(raw, i, arg);
            i += 1;
            continue;
        }
        if (arg === "--queue") {
            parsed.queue = requireValue(raw, i, arg);
            i += 1;
            continue;
        }
        if (arg === "--subject") {
            parsed.subject = requireValue(raw, i, arg);
            i += 1;
            continue;
        }
        if (arg === "--start-seq") {
            parsed.startSeq = parsePositiveCliInteger(
                requireValue(raw, i, arg),
                arg,
            );
            i += 1;
            continue;
        }
        if (arg === "--limit") {
            parsed.limit = parsePositiveCliInteger(
                requireValue(raw, i, arg),
                arg,
            );
            i += 1;
            continue;
        }
        if (arg === "--top") {
            parsed.top = parsePositiveCliInteger(
                requireValue(raw, i, arg),
                arg,
            );
            i += 1;
            continue;
        }
        if (arg === "--samples") {
            parsed.samples = parseNonNegativeCliInteger(
                requireValue(raw, i, arg),
                arg,
            );
            i += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return parsed;
}

function requireValue(raw: string[], index: number, name: string): string {
    const value = raw[index + 1];
    if (!value) {
        throw new Error(`Missing value for ${name}`);
    }
    return value;
}

function parsePositiveCliInteger(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}

function parseNonNegativeCliInteger(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}

function formatJetStreamError(error: JetStreamApiError): string {
    return `JetStream API error ${error.err_code}: ${error.description}`;
}

function printUsage(): void {
    console.log(
        [
            "Usage: yarn workspace @artgod/indexer run inspect:queue [options]",
            "",
            "Reads stored JetStream messages through the direct stream API and does not create, advance, ack, or nack any consumer.",
            "",
            "Options:",
            "  --queue <queue>             Queue name (default: order-updates-by-maker)",
            "  --subject <subject>         Full stream subject override",
            "  --server <url>              NATS server URL (default: NATS_URL)",
            "  --stream-prefix <prefix>    Stream prefix (default: NATS_STREAM_PREFIX)",
            "  --stream <stream>           Stream name override",
            "  --start-seq <number>        First stream sequence to inspect",
            "  --limit <number>            Maximum messages to inspect (default: 10000)",
            "  --top <number>              Top bucket count per section (default: 20)",
            "  --samples <number>          First/last decoded job samples (default: 3)",
        ].join("\n"),
    );
}
