import {
    JSONCodec,
    RetentionPolicy,
    StorageType,
    connect,
    type JetStreamClient,
    type JetStreamManager,
    type NatsConnection,
} from "nats";
import {
    TRADING_JOB_SIGNAL_KIND,
    tradingBiddingJobsChangedSubject,
    tradingJobSignalStreamName,
    type TradingBiddingJobsChangedSignal,
    type TradingJobCommandRecord,
} from "@artgod/shared/types";
import { logger } from "@artgod/shared/utils";
import type { TradingJobCommandSignalPort } from "../../application/use-cases/trading/trading-job-command-signal-port.js";

export class NatsTradingJobCommandSignalPublisher
    implements TradingJobCommandSignalPort
{
    private readonly streamName: string;
    private readonly subject: string;
    private connectionReady?: Promise<{
        connection: NatsConnection;
        js: JetStreamClient;
        jsm: JetStreamManager;
    }>;

    constructor(
        private readonly natsUrl: string,
        private readonly streamPrefix: string,
    ) {
        this.streamName = tradingJobSignalStreamName(streamPrefix);
        this.subject = tradingBiddingJobsChangedSubject(streamPrefix);
    }

    publishBiddingJobCommandsChanged(
        commands: TradingJobCommandRecord[],
    ): void {
        if (commands.length === 0) {
            return;
        }

        void this.publish(commands).catch((error: unknown) => {
            this.connectionReady = undefined;
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("Trading job command wake-up publish failed", {
                error: message,
                commandIds: commands.map((command) => command.commandId),
            });
        });
    }

    async close(): Promise<void> {
        const ready = await this.connectionReady?.catch(() => undefined);
        await ready?.connection.drain().catch(() => undefined);
    }

    private async publish(commands: TradingJobCommandRecord[]): Promise<void> {
        const { js, jsm } = await this.getConnection();
        await ensureTradingSignalStream(jsm, this.streamName, this.subject);
        const codec = JSONCodec<TradingBiddingJobsChangedSignal>();
        const signal: TradingBiddingJobsChangedSignal = {
            kind: TRADING_JOB_SIGNAL_KIND.BiddingJobsChanged,
            commandIds: commands.map((command) => command.commandId),
            jobIds: Array.from(new Set(commands.map((command) => command.jobId))),
            publishedAt: new Date().toISOString(),
        };
        const msgID = `bidding-jobs-changed:${signal.commandIds.join(",")}`;

        // Publish a compact JetStream wake-up; the bot reloads authoritative command/job state from SQLite.
        await js.publish(this.subject, codec.encode(signal), { msgID });
    }

    private async getConnection(): Promise<{
        connection: NatsConnection;
        js: JetStreamClient;
        jsm: JetStreamManager;
    }> {
        if (!this.connectionReady) {
            this.connectionReady = (async () => {
                const connection = await connect({ servers: this.natsUrl });
                return {
                    connection,
                    js: connection.jetstream(),
                    jsm: await connection.jetstreamManager(),
                };
            })();
        }

        return await this.connectionReady;
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
