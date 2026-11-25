import { ORDERBOOK_VENUE } from "@artgod/shared/market-data/orders";
import type { JobEnvelope } from "../../domain/jobs.js";
import {
    ORDER_JOB_KIND,
    type OrderUpsertPayload,
} from "../../domain/order-jobs.js";
import type { OrdersDomainPort } from "../../ports/domain-handlers.js";

/** Old passive deliveries may already be in flight at cutover. Only the
 * completed feed publication may introduce an order from a managed venue. */
export async function consumeOrderUpsert(
    job: JobEnvelope<OrderUpsertPayload>,
    domain: Pick<OrdersDomainPort, "handleOrderUpsert">,
) {
    if (
        job.kind !== ORDER_JOB_KIND.Upsert ||
        job.payload.source === ORDERBOOK_VENUE.OpenSea ||
        job.payload.source === ORDERBOOK_VENUE.Vvv
    )
        return;
    await domain.handleOrderUpsert({
        ...job.payload,
        observedAt:
            job.payload.observedAt ?? Math.floor(job.scheduledAt / 1000),
    });
}
