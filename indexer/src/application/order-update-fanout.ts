import type { CollectionRecord } from "../domain/collections.js";
import type { JobEnvelope } from "../domain/jobs.js";
import type { OnChainData } from "../domain/onchain.js";
import {
    MAKER_TRIGGER_SCOPE,
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
} from "../domain/order-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import type { BackfillOrderMaintenancePolicy } from "../domain/sync-jobs.js";
import type { QueuePort } from "../ports/queue.js";
import { allowsGlobalMakerRevalidation } from "./backfill-order-maintenance.js";

// Order update jobs are triggered by fills/cancels/on-chain orders or maker state changes.
export async function publishOrderUpdateJobs(
    queue: QueuePort,
    chainId: number,
    collections: CollectionRecord[],
    data: OnChainData,
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy,
): Promise<void> {
    for (const makerTrigger of data.collectionScoped.makerTriggers) {
        const maker = makerTrigger.maker.toLowerCase();
        const job: JobEnvelope<OrderUpdateByMakerPayload> = {
            jobId: `orders:update:maker:${chainId}:${maker}:${makerTrigger.collectionId}:${makerTrigger.tokenId}:${makerTrigger.blockNumber}:${makerTrigger.logIndex}`,
            kind: ORDER_JOB_KIND.UpdateByMaker,
            queue: QUEUE_NAMES.OrdersUpdateByMaker,
            payload: {
                chainId,
                scope: MAKER_TRIGGER_SCOPE.Token,
                maker: makerTrigger.maker,
                collectionId: makerTrigger.collectionId,
                contract: makerTrigger.contract,
                tokenId: makerTrigger.tokenId,
                reason: makerTrigger.reason,
                blockNumber: makerTrigger.blockNumber,
                blockHash: makerTrigger.blockHash,
                txHash: makerTrigger.txHash,
                logIndex: makerTrigger.logIndex,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId: makerTrigger.collectionId,
        };
        await queue.publish(QUEUE_NAMES.OrdersUpdateByMaker, job);
    }

    if (allowsGlobalMakerRevalidation(orderMaintenancePolicy)) {
        for (const makerTrigger of data.global.makerTriggers) {
            if (
                !canAnyCollectionProjectCurrentStateAt(
                    collections,
                    makerTrigger.blockNumber,
                )
            ) {
                continue;
            }
            const maker = makerTrigger.maker.toLowerCase();
            const job: JobEnvelope<OrderUpdateByMakerPayload> = {
                jobId: `orders:update:maker:${chainId}:${maker}:global:${makerTrigger.reason}:${makerTrigger.blockNumber}:${makerTrigger.logIndex}`,
                kind: ORDER_JOB_KIND.UpdateByMaker,
                queue: QUEUE_NAMES.OrdersUpdateByMaker,
                payload: {
                    chainId,
                    scope: MAKER_TRIGGER_SCOPE.Global,
                    maker: makerTrigger.maker,
                    reason: makerTrigger.reason,
                    blockNumber: makerTrigger.blockNumber,
                    blockHash: makerTrigger.blockHash,
                    txHash: makerTrigger.txHash,
                    logIndex: makerTrigger.logIndex,
                },
                attempt: 0,
                scheduledAt: Date.now(),
                chainId,
            };
            await queue.publish(QUEUE_NAMES.OrdersUpdateByMaker, job);
        }
    }

    for (const fill of data.collectionScoped.fillEvents) {
        if (!fill.orderId) continue;
        await publishOrderUpdateById(
            queue,
            chainId,
            fill.orderId,
            "fill",
            fill,
        );
    }

    for (const cancel of data.global.cancelEvents) {
        if (!cancel.orderId) continue;
        if (
            !canAnyCollectionProjectCurrentStateAt(
                collections,
                cancel.blockNumber,
            )
        ) {
            continue;
        }
        await publishOrderUpdateById(
            queue,
            chainId,
            cancel.orderId,
            "cancel",
            cancel,
        );
    }

    for (const order of data.collectionScoped.orderInfos) {
        if (!order.orderId) continue;
        await publishOrderUpdateById(
            queue,
            chainId,
            order.orderId,
            "order",
            order,
        );
    }
}

// Coarse gate for global triggers.
export function canAnyCollectionProjectCurrentStateAt(
    collections: CollectionRecord[],
    blockNumber: number,
): boolean {
    return collections.some((collection) =>
        collection.canProjectCurrentStateAt(blockNumber),
    );
}

async function publishOrderUpdateById(
    queue: QueuePort,
    chainId: number,
    orderId: string,
    reason: string,
    attribution: {
        blockNumber: number;
        blockHash: string;
        txHash: string;
        logIndex: number;
    },
): Promise<void> {
    const job: JobEnvelope<OrderUpdateByIdPayload> = {
        jobId: `orders:update:id:${chainId}:${orderId}:${attribution.blockNumber}:${attribution.logIndex}`,
        kind: ORDER_JOB_KIND.UpdateById,
        queue: QUEUE_NAMES.OrdersUpdateById,
        payload: {
            chainId,
            orderId,
            reason,
            blockNumber: attribution.blockNumber,
            blockHash: attribution.blockHash,
            txHash: attribution.txHash,
            logIndex: attribution.logIndex,
        },
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
    };
    await queue.publish(QUEUE_NAMES.OrdersUpdateById, job);
}
