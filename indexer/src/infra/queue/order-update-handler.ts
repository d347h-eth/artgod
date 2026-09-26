import type { JobEnvelope } from "../../domain/jobs.js";
import {
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
} from "../../domain/order-jobs.js";
import { QUEUE_NAMES, type QueueName } from "../../domain/queues.js";
import { orderUpdateQueue } from "../../domain/order-processing.js";
import { UnsupportedJob } from "../../domain/unsupported-job.js";
import type { ApplyOrderUpdate } from "../../application/orders/apply-order-update.js";
import { LegacyOrderAdmission } from "../orders/legacy-order-admission.js";

/** Both old mixed envelopes and the new lifecycle route retain original attribution. */
export function orderUpdateHandler(deps: {
    chainId: number;
    queueName: QueueName;
    apply: Pick<ApplyOrderUpdate, "execute">;
    admission?: Pick<LegacyOrderAdmission, "enter">;
}) {
    const admission = deps.admission ?? new LegacyOrderAdmission();
    return async (job: JobEnvelope<OrderUpdateByIdPayload>) => {
        if (deps.queueName === QUEUE_NAMES.OrdersUpdateById)
            await admission.enter();
        if (
            job.kind !== ORDER_JOB_KIND.UpdateById ||
            job.chainId !== deps.chainId ||
            !job.payload ||
            job.payload.chainId !== deps.chainId ||
            typeof job.payload.orderId !== "string" ||
            !job.payload.orderId ||
            !Number.isSafeInteger(job.scheduledAt) ||
            job.scheduledAt < 0 ||
            [
                job.payload.blockNumber,
                job.payload.logIndex,
                job.payload.observedAt,
                job.payload.validUntil,
            ].some(
                (value) =>
                    value != null &&
                    (!Number.isSafeInteger(value) || value < 0),
            ) ||
            (job.payload.collectionId != null &&
                (!Number.isSafeInteger(job.payload.collectionId) ||
                    job.payload.collectionId <= 0)) ||
            (deps.queueName === QUEUE_NAMES.OrderLifecycle &&
                orderUpdateQueue(job.payload) !== deps.queueName)
        )
            throw new UnsupportedJob("Unsupported order queue envelope");
        await deps.apply.execute(
            {
                ...job.payload,
                collectionId: job.payload.collectionId ?? job.collectionId,
                observedAt:
                    job.payload.observedAt ??
                    Math.floor(job.scheduledAt / 1000),
            },
            job.scheduledAt,
        );
    };
}
