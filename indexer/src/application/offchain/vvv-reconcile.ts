import { ORDERBOOK_VENUE } from "@artgod/shared/market-data/orders";
import {
    VVV_READ_INTERVAL_MS,
    VVV_READ_JOB,
    type BookFeed,
    type BookObservation,
    type BoundMarketJob,
} from "../../domain/orderbook.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import type { QueuePort } from "../../ports/queue.js";
import type {
    BookPublicationPort,
    OrderbookSchedulePort,
} from "../../ports/orderbooks.js";

export async function scheduleVvvBooks(
    store: Pick<OrderbookSchedulePort, "due">,
    queue: Pick<QueuePort, "publish">,
    chainId: number,
    now = Date.now(),
) {
    for (const payload of store.due(
        ORDERBOOK_VENUE.Vvv,
        chainId,
        now - VVV_READ_INTERVAL_MS,
    )) {
        await queue.publish(QUEUE_NAMES.VvvReconcile, {
            jobId: [
                VVV_READ_JOB,
                payload.feedId,
                payload.bindingRevision,
                payload.generation,
                Math.floor(now / VVV_READ_INTERVAL_MS),
            ].join(":"),
            kind: VVV_READ_JOB,
            queue: QUEUE_NAMES.VvvReconcile,
            chainId,
            payload,
            scheduledAt: now,
            attempt: 0,
        });
    }
}
export async function reconcileVvvBook(
    store: Pick<OrderbookSchedulePort, "current"> &
        Pick<BookPublicationPort, "begin">,
    reader: {
        read(
            feed: BookFeed,
            visit: (record: BookObservation) => void,
        ): Promise<void>;
    },
    chainId: number,
    job: BoundMarketJob,
) {
    const feed = store.current(ORDERBOOK_VENUE.Vvv, chainId, job);
    if (!feed) return;
    const read = store.begin(feed);
    try {
        await reader.read(feed, read.record);
        return read.publish();
    } catch (error) {
        read.fail(error);
        throw error;
    } finally {
        read.close();
    }
}
