import { db } from "@artgod/shared/database";
import { MARKET_DATA_STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import {
    ORDER_SOURCE_STATUS,
    type OrderSourceStatus,
} from "../../domain/orders.js";
import {
    aggregateOrderAvailability,
    sourceAvailabilityAfterObservation,
} from "../../domain/order-observation.js";

type SourceObservationRow = {
    observation_key: string;
    source_status: OrderSourceStatus;
};

/** One compact record per source/declaration; retransmissions do not allocate
 * another local validation obligation, even when another source arrived between. */
export class SqliteOrderObservations {
    retain(input: {
        chainId: number;
        collectionId: number;
        orderId: string;
        sourceId: string;
        observationKey: string;
        status?: OrderSourceStatus | null;
        declaration: boolean;
        quantity?: string | null;
        sourceObservedAt?: number | null;
        validUntil?: number | null;
        now: number;
    }): { changed: boolean; availability: OrderSourceStatus } {
        if (!db.raw.inTransaction)
            throw new Error("Order observation requires its admission writer");
        const previous = db
            .prepare(
                "SELECT observation_key,source_status FROM order_source_observations WHERE chain_id=? AND order_id=? AND source_id=?",
            )
            .get(input.chainId, input.orderId, input.sourceId) as
            | SourceObservationRow
            | undefined;
        const changed = previous?.observation_key !== input.observationKey;
        if (changed) {
            // An old create/REST copy cannot undo this source's explicit withdrawal.
            // A revalidation observation can reopen that source; another source's
            // availability is independent in either case.
            const status = sourceAvailabilityAfterObservation(
                previous?.source_status,
                input.status,
                input.declaration,
            );
            const expiry =
                input.validUntil != null
                    ? input.validUntil * 1_000 +
                      MARKET_DATA_STORAGE_POLICY.orderReorgGraceSeconds * 1_000
                    : input.now +
                      MARKET_DATA_STORAGE_POLICY.unknownOrderLifetimeSeconds *
                          1_000;
            db.prepare(
                `INSERT INTO order_source_observations(chain_id,collection_id,order_id,source_id,source_status,observation_key,declared_quantity,source_observed_at,admitted_at,expires_at)
                 VALUES (@chainId,@collectionId,@orderId,@sourceId,@status,@observationKey,@quantity,@observedAt,@now,@expiry)
                 ON CONFLICT(chain_id,order_id,source_id) DO UPDATE SET source_status=excluded.source_status,observation_key=excluded.observation_key,
                   declared_quantity=COALESCE(excluded.declared_quantity,declared_quantity),source_observed_at=excluded.source_observed_at,
                   admitted_at=excluded.admitted_at,expires_at=excluded.expires_at`,
            ).run({
                ...input,
                status,
                quantity: input.quantity ?? null,
                observedAt: input.sourceObservedAt ?? null,
                expiry,
            });
        }
        const active = db
            .prepare(
                "SELECT 1 FROM order_source_observations WHERE chain_id=? AND order_id=? AND source_status=? LIMIT 1",
            )
            .get(input.chainId, input.orderId, ORDER_SOURCE_STATUS.Active);
        return {
            changed,
            availability: aggregateOrderAvailability(Boolean(active)),
        };
    }
}
