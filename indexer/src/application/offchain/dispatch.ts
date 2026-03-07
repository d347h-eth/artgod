import { logger } from "@artgod/shared/utils";
import {
    normalizeOffchainMetadataRefresh,
    normalizeOffchainOrder,
    normalizeOffchainOrderUpdateById,
    normalizeOffchainOrderUpdateByMaker,
} from "./normalize.js";
import { DOMAIN_JOB_KIND } from "../../domain/domain-jobs.js";
import {
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
    type OrderUpsertPayload,
} from "../../domain/order-jobs.js";
import type { OffchainOrderRawPayload } from "../../domain/offchain-jobs.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import type { QueuePort } from "../../ports/queue.js";
import type { TokenSetRegistryPort } from "../../ports/token-sets.js";
import type { MetadataRefreshPayload } from "../../domain/domain-jobs.js";

export type DispatchOffchainPayloadResult = {
    handled: boolean;
    upsertedOrderId: string | null;
};

export async function dispatchOffchainPayload(
    queue: QueuePort,
    tokenSets: TokenSetRegistryPort,
    payload: OffchainOrderRawPayload,
): Promise<DispatchOffchainPayloadResult> {
    let handled = false;
    let upsertedOrderId: string | null = null;

    const normalized = normalizeOffchainOrder(payload);
    if (normalized) {
        let tokenSetId: string | null = null;
        let tokenSetSchemaHash: string | null = null;
        if (normalized.tokenSetSchema) {
            const resolved = tokenSets.ensureTokenSet({
                chainId: normalized.chainId,
                schema: normalized.tokenSetSchema,
                criteriaRoot: normalized.criteriaRoot ?? null,
            });
            if (!resolved) {
                logger.warn("Offchain token set unresolved", {
                    component: "OffchainDispatch",
                    action: "dispatch",
                    source: normalized.source,
                    orderId: normalized.orderId,
                    chainId: normalized.chainId,
                    collectionId: payload.collectionId,
                });
                return {
                    handled: true,
                    upsertedOrderId: null,
                };
            }
            tokenSetId = resolved.tokenSetId;
            tokenSetSchemaHash = resolved.schemaHash;
        }

        const upsertJob: JobEnvelope<OrderUpsertPayload> = {
            jobId: `orders:upsert:${normalized.chainId}:${normalized.orderId}:${payload.receivedAt}`,
            kind: ORDER_JOB_KIND.Upsert,
            queue: QUEUE_NAMES.OrdersUpsert,
            payload: {
                chainId: normalized.chainId,
                orderId: normalized.orderId,
                kind: normalized.kind,
                side: normalized.side,
                maker: normalized.maker,
                taker: normalized.taker ?? null,
                contract: normalized.contract,
                tokenId: normalized.tokenId ?? null,
                tokenSetId,
                tokenSetSchemaHash,
                price: normalized.price ?? null,
                currency: normalized.currency ?? null,
                validFrom: normalized.validFrom ?? null,
                validUntil: normalized.validUntil ?? null,
                source: normalized.source,
                sourceStatus: "active",
                rawData: normalized.rawData,
                validateAfterUpsert: true,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId: normalized.chainId,
            collectionId: payload.collectionId,
        };
        await queue.publish(QUEUE_NAMES.OrdersUpsert, upsertJob);
        handled = true;
        upsertedOrderId = normalized.orderId;
    }

    const updateById = normalizeOffchainOrderUpdateById(payload);
    if (updateById) {
        const updateJob: JobEnvelope<OrderUpdateByIdPayload> = {
            jobId: `orders:update:id:offchain:${updateById.chainId}:${updateById.orderId}:${payload.receivedAt}:${updateById.sourceStatus}`,
            kind: ORDER_JOB_KIND.UpdateById,
            queue: QUEUE_NAMES.OrdersUpdateById,
            payload: {
                chainId: updateById.chainId,
                orderId: updateById.orderId,
                reason: updateById.reason,
                sourceStatus: updateById.sourceStatus,
                blockNumber: 0,
                blockHash: "0x0",
                txHash: "0x0",
                logIndex: 0,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId: updateById.chainId,
            collectionId: payload.collectionId,
            traceId: payload.source ?? payload.receivedAt.toString(),
        };
        await queue.publish(QUEUE_NAMES.OrdersUpdateById, updateJob);
        handled = true;
    }

    const updateByMaker = normalizeOffchainOrderUpdateByMaker(payload);
    if (updateByMaker) {
        const makerJob: JobEnvelope<OrderUpdateByMakerPayload> = {
            jobId: `orders:update:maker:offchain:${updateByMaker.chainId}:${updateByMaker.maker}:${updateByMaker.contract}:${updateByMaker.tokenId}:${payload.receivedAt}`,
            kind: ORDER_JOB_KIND.UpdateByMaker,
            queue: QUEUE_NAMES.OrdersUpdateByMaker,
            payload: {
                chainId: updateByMaker.chainId,
                maker: updateByMaker.maker,
                contract: updateByMaker.contract,
                tokenId: updateByMaker.tokenId,
                reason: updateByMaker.reason,
                blockNumber: 0,
                blockHash: "0x0",
                txHash: "0x0",
                logIndex: 0,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId: updateByMaker.chainId,
            collectionId: payload.collectionId,
            traceId: payload.source ?? payload.receivedAt.toString(),
        };
        await queue.publish(QUEUE_NAMES.OrdersUpdateByMaker, makerJob);
        handled = true;
    }

    const metadataRefresh = normalizeOffchainMetadataRefresh(payload);
    if (metadataRefresh) {
        const refreshJob: JobEnvelope<MetadataRefreshPayload> = {
            jobId: `metadata:refresh:offchain:${metadataRefresh.chainId}:${metadataRefresh.contract}:${metadataRefresh.tokenId}:${payload.receivedAt}`,
            kind: DOMAIN_JOB_KIND.MetadataRefresh,
            queue: QUEUE_NAMES.MetadataRefresh,
            payload: {
                chainId: metadataRefresh.chainId,
                contract: metadataRefresh.contract,
                tokenId: metadataRefresh.tokenId,
                metadataUrl: metadataRefresh.metadataUrl,
                reason: metadataRefresh.reason,
                source: metadataRefresh.source,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId: metadataRefresh.chainId,
            collectionId: payload.collectionId,
            traceId: payload.source ?? payload.receivedAt.toString(),
        };
        await queue.publish(QUEUE_NAMES.MetadataRefresh, refreshJob);
        handled = true;
    }

    return {
        handled,
        upsertedOrderId,
    };
}
