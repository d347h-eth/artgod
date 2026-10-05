import {
    PRICE_HISTORY_LIMITS,
    type PriceHistoryObservation,
} from "@artgod/shared/types/price-history";
import type { PriceHistoryReadPort } from "../../application/use-cases/collections/get-price-history.js";
import {
    QUERY_CACHE_NAMESPACES,
    type QueryCachePort,
} from "../../ports/query-cache.js";

/** Public-only, expiring collection snapshot. No projection, event listener, or
 * stale fallback: after expiry a read observes current SQLite facts, including deletions. */
export class CachedPriceHistoryRead implements PriceHistoryReadPort {
    constructor(
        private readonly source: PriceHistoryReadPort,
        private readonly cache: QueryCachePort,
        private readonly ttlMs: number,
    ) {}

    *iterateObservations(
        input: Parameters<PriceHistoryReadPort["iterateObservations"]>[0],
    ): Iterable<PriceHistoryObservation> {
        // Reuse the token browser's current-attribute query for filtered reads.
        // Do not cache filtered snapshots or let a metadata change outlive a request.
        if (input.traits?.length || input.traitRanges?.length) {
            yield* this.source.iterateObservations(input);
            return;
        }
        const key = `${input.chainId}:${input.collectionId}`;
        let sales = this.cache.get<readonly PriceHistoryObservation[]>(
            QUERY_CACHE_NAMESPACES.CollectionSales,
            key,
        );
        if (!sales) {
            const snapshot = Array.from(
                this.source.iterateObservations({
                    ...input,
                    tokenId: undefined,
                    from: 0,
                    limit: PRICE_HISTORY_LIMITS.fills + 1,
                }),
            );
            if (snapshot.length > PRICE_HISTORY_LIMITS.fills) {
                // An oversized collection must still allow a bounded shorter range.
                yield* this.source.iterateObservations(input);
                return;
            }
            sales = snapshot;
            this.cache.set(
                QUERY_CACHE_NAMESPACES.CollectionSales,
                key,
                sales,
                this.ttlMs,
            );
        }
        let count = 0;
        for (const sale of sales) {
            if (sale.timestamp >= input.to) break;
            if (
                sale.timestamp < input.from ||
                (input.tokenId !== undefined && sale.tokenId !== input.tokenId)
            )
                continue;
            yield sale;
            if (++count >= input.limit) break;
        }
    }
}
