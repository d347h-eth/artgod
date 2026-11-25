import type {
    BookFeed,
    BookCoverage,
    BookObservation,
    BoundMarketJob,
} from "../domain/orderbook.js";

/** A visit stages one observation privately. Publication and its validation
 * obligations must be durable together before the caller reports success. */
export interface BookPublicationPort {
    bind(feed: BookFeed, collectionId: number): number;
    alreadyAccepted(feed: BookFeed, since: number): boolean;
    begin(
        feed: BookFeed,
        coverage?: BookCoverage,
        received?: number,
    ): {
        record(observation: BookObservation): void;
        publish(): { activeOrders: number; deactivatedOrders: number };
        fail(reason: unknown): void;
        close(): void;
    };
}

export interface OrderbookSchedulePort {
    due(
        venue: BookFeed["venue"],
        chainId: number,
        before: number,
    ): BoundMarketJob[];
    current(
        venue: BookFeed["venue"],
        chainId: number,
        job: BoundMarketJob,
    ): BookFeed | undefined;
}
