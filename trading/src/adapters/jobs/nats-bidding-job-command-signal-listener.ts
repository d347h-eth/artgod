import {
    JSONCodec,
    RetentionPolicy,
    StorageType,
    connect,
    consumerOpts,
    createInbox,
    type JetStreamManager,
} from "nats";
import {
    TRADING_JOB_SIGNAL_KIND,
    tradingBiddingJobsChangedSubject,
    tradingJobSignalStreamName,
    type TradingBiddingJobsChangedSignal,
} from "@artgod/shared/types";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../utils/bidding-log.js";

export type BiddingJobCommandSignalListenerConfig = {
    natsUrl: string;
    streamPrefix: string;
    consumerName: string;
};

export type BiddingJobCommandSignalHandler = (
    signal: TradingBiddingJobsChangedSignal,
) => Promise<void>;

export type BiddingJobCommandSignalListenerHandle = {
    shutdown(): Promise<void>;
};

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.BiddingCommandSignalListener,
);

export class NatsBiddingJobCommandSignalListener {
    private readonly streamName: string;
    private readonly subject: string;

    constructor(private readonly config: BiddingJobCommandSignalListenerConfig) {
        this.streamName = tradingJobSignalStreamName(config.streamPrefix);
        this.subject = tradingBiddingJobsChangedSubject(config.streamPrefix);
    }

    async start(
        handler: BiddingJobCommandSignalHandler,
    ): Promise<BiddingJobCommandSignalListenerHandle> {
        const connection = await connect({ servers: this.config.natsUrl });
        const js = connection.jetstream();
        const jsm = await connection.jetstreamManager();
        await ensureTradingSignalStream(jsm, this.streamName, this.subject);

        const codec = JSONCodec<TradingBiddingJobsChangedSignal>();
        const options = consumerOpts();
        options.durable(this.config.consumerName);
        options.manualAck();
        options.ackExplicit();
        options.deliverNew();
        options.deliverTo(createInbox());
        options.filterSubject(this.subject);

        // Subscribe to JetStream wake-up signals so DB Outbox processing can run immediately after CRUD.
        const subscription = await js.subscribe(this.subject, options);
        let stopping = false;
        const tasks = new Set<Promise<void>>();
        const loop = (async () => {
            for await (const message of subscription) {
                if (stopping) {
                    message.term();
                    continue;
                }

                const task = (async () => {
                    let signal: TradingBiddingJobsChangedSignal;
                    try {
                        signal = codec.decode(message.data);
                    } catch (error) {
                        log.warn(
                            "invalidSignalPayload",
                            "Dropping invalid bidding job signal payload",
                            toErrorLogFields(error),
                        );
                        message.term();
                        return;
                    }

                    if (
                        signal.kind !==
                        TRADING_JOB_SIGNAL_KIND.BiddingJobsChanged
                    ) {
                        log.warn(
                            "unsupportedSignalKind",
                            "Dropping unsupported bidding job signal kind",
                            { signalKind: String(signal.kind) },
                        );
                        message.term();
                        return;
                    }

                    try {
                        log.info("signalReceived", "Received bidding job wake-up signal", {
                            commandCount: signal.commandIds.length,
                            jobCount: signal.jobIds.length,
                        });
                        await handler(signal);
                        message.ack();
                    } catch (error) {
                        log.warn(
                            "signalHandlingFailed",
                            "Bidding job signal handling failed; message will be retried",
                            toErrorLogFields(error),
                        );
                        message.nak();
                    }
                })();

                tasks.add(task);
                task.finally(() => tasks.delete(task));
            }
        })();

        return {
            shutdown: async () => {
                stopping = true;
                subscription.drain();
                await loop.catch(() => undefined);
                if (tasks.size > 0) {
                    await Promise.allSettled(Array.from(tasks));
                }
                await connection.drain().catch(() => undefined);
            },
        };
    }
}

async function ensureTradingSignalStream(
    jsm: JetStreamManager,
    streamName: string,
    subject: string,
): Promise<void> {
    try {
        await jsm.streams.info(streamName);
        return;
    } catch {}

    await jsm.streams.add({
        name: streamName,
        subjects: [subject],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_age: 24 * 60 * 60 * 1_000_000_000,
    });
}
