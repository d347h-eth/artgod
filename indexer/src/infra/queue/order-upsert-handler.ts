import type { JobEnvelope } from "../../domain/jobs.js";
import {
    ORDER_JOB_KIND,
    type OrderUpsertPayload,
} from "../../domain/order-jobs.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_SOURCE_SCOPE_KIND,
} from "../../domain/orders.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import { UnsupportedJob } from "../../domain/unsupported-job.js";
import type { OrdersDomainPort } from "../../ports/domain-handlers.js";

/** Source provenance belongs to the original observation, including on retry.
 * Queue scheduling time cannot replace a missing source observation time. */
export function orderUpsertHandler(deps: {
    chainId: number;
    orders: Pick<OrdersDomainPort, "handleOrderUpsert">;
}) {
    return async (job: JobEnvelope<OrderUpsertPayload>): Promise<void> => {
        const payload = job.payload;
        if (
            job.kind !== ORDER_JOB_KIND.Upsert ||
            job.queue !== QUEUE_NAMES.OrdersUpsert ||
            job.chainId !== deps.chainId ||
            !payload ||
            payload.chainId !== deps.chainId ||
            !Number.isSafeInteger(payload.collectionId) ||
            payload.collectionId <= 0 ||
            typeof payload.observedAt !== "number" ||
            !Number.isSafeInteger(payload.observedAt) ||
            payload.observedAt < 0 ||
            typeof payload.source !== "string" ||
            !payload.source.trim() ||
            !Object.values(ORDER_SOURCE_SCOPE_KIND).includes(
                payload.sourceScopeKind,
            ) ||
            !Object.values(ORDER_SEAPORT_DATA_SOURCE_KIND).includes(
                payload.rawSourceKind,
            )
        )
            throw new UnsupportedJob("Unsupported order upsert envelope");
        await deps.orders.handleOrderUpsert(payload);
    };
}
