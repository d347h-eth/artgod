import {
    SYNC_WORK_CLASS,
    decodeSyncWorkClass,
} from "@artgod/shared/types/sync-work-class";
import type { RevalidateMakerOrders } from "../../application/orders/revalidate-maker.js";
import { JobDeferred } from "../../domain/job-deferred.js";
import type { JobEnvelope, QueueDeliveryOrigin } from "../../domain/jobs.js";
import { MAKER_REVALIDATION_POLICY } from "../../domain/maker-revalidation.js";
import {
    ORDER_JOB_KIND,
    type OrderMakerContinuationPayload,
    type OrderUpdateByMakerPayload,
} from "../../domain/order-jobs.js";
import { makerUpdateQueue } from "../../domain/order-processing.js";
import { QUEUE_NAMES, type QueueName } from "../../domain/queues.js";
import { UnsupportedJob } from "../../domain/unsupported-job.js";

/** Queue deliveries require replay evidence; canonical writer admission has no
 * broker receipt and enters the store directly through its separate port. */
export function makerUpdateHandler(deps: {
    chainId: number;
    queueName: QueueName;
    processor: Pick<RevalidateMakerOrders, "execute" | "resume">;
}) {
    if (
        deps.queueName !== QUEUE_NAMES.OrdersUpdateByMaker &&
        deps.queueName !== QUEUE_NAMES.OrdersUpdateByToken
    )
        throw new Error("Unsupported maker consumer queue");
    return async (
        job: JobEnvelope<
            OrderUpdateByMakerPayload | OrderMakerContinuationPayload
        >,
        origin?: QueueDeliveryOrigin,
    ): Promise<void> => {
        if (
            (job.kind !== ORDER_JOB_KIND.UpdateByMaker &&
                job.kind !== ORDER_JOB_KIND.ContinueMaker) ||
            job.queue !== deps.queueName ||
            job.chainId !== deps.chainId ||
            !job.payload ||
            typeof job.payload !== "object" ||
            job.payload.chainId !== deps.chainId ||
            "continuation" in job.payload
        )
            throw new UnsupportedJob("Unsupported maker queue envelope");
        if (
            job.kind === ORDER_JOB_KIND.UpdateByMaker &&
            makerUpdateQueue(job.payload as OrderUpdateByMakerPayload) !==
                deps.queueName
        )
            throw new UnsupportedJob("Maker scope belongs to another queue");
        if (
            !origin ||
            typeof origin.streamId !== "string" ||
            !origin.streamId ||
            typeof origin.consumerName !== "string" ||
            !origin.consumerName ||
            !Number.isSafeInteger(origin.sequence) ||
            origin.sequence < 1
        )
            throw new JobDeferred(
                "Maker delivery evidence unavailable",
                MAKER_REVALIDATION_POLICY.admissionRetryMs,
            );
        if (job.kind === ORDER_JOB_KIND.ContinueMaker) {
            await deps.processor.resume({
                jobId: job.jobId,
                payload: job.payload as OrderMakerContinuationPayload,
                queueName: deps.queueName,
                origin,
            });
            return;
        }
        const workClass = decodeSyncWorkClass(job.workClass);
        await deps.processor.execute({
            jobId: job.jobId,
            payload: {
                ...(job.payload as OrderUpdateByMakerPayload),
                workClass,
            },
            admissionOnly: workClass === SYNC_WORK_CLASS.GapRepair,
            origin,
        });
    };
}
