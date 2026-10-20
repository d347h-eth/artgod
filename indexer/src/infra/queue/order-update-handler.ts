import type { JobEnvelope } from "../../domain/jobs.js";
import {
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
} from "../../domain/order-jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import { orderUpdateQueue } from "../../domain/order-processing.js";
import { UnsupportedJob } from "../../domain/unsupported-job.js";
import type { ApplyOrderUpdate } from "../../application/orders/apply-order-update.js";

/** Source deliveries carry their original collection and observation time. */
export function orderUpdateHandler(deps: {
    chainId: number;
    apply: Pick<ApplyOrderUpdate, "execute">;
}) {
    return async (job: JobEnvelope<OrderUpdateByIdPayload>) => {
        if (
            job.kind !== ORDER_JOB_KIND.UpdateById ||
            job.queue !== QUEUE_NAMES.OrderLifecycle ||
            job.chainId !== deps.chainId ||
            !job.payload ||
            job.payload.chainId !== deps.chainId ||
            typeof job.payload.orderId !== "string" ||
            !job.payload.orderId ||
            !Number.isSafeInteger(job.scheduledAt) ||
            job.scheduledAt < 0 ||
            [job.payload.observedAt, job.payload.validUntil].some(
                (value) =>
                    value != null &&
                    (!Number.isSafeInteger(value) || value < 0),
            ) ||
            job.payload.collectionId == null ||
            !Number.isSafeInteger(job.payload.collectionId) ||
            job.payload.collectionId <= 0 ||
            job.payload.observedAt == null ||
            orderUpdateQueue(job.payload) !== QUEUE_NAMES.OrderLifecycle
        )
            throw new UnsupportedJob("Unsupported order queue envelope");
        await deps.apply.execute(job.payload);
    };
}
