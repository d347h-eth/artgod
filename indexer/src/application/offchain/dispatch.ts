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
import {
    ORDER_LOCAL_TOKEN_SET_STATUS,
    ORDER_SOURCE_SCOPE_KIND,
} from "../../domain/orders.js";

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
        let localTokenSetStatus =
            normalized.localTokenSetStatus ?? ORDER_LOCAL_TOKEN_SET_STATUS.None;

        if (normalized.sourceSchema) {
            const resolved = tokenSets.ensureTokenSet({
                chainId: normalized.chainId,
                collectionId: payload.collectionId,
                schema: normalized.sourceSchema,
            });
            if (!resolved) {
                localTokenSetStatus = ORDER_LOCAL_TOKEN_SET_STATUS.Unresolved;
                logger.warn("Offchain token set unresolved", {
                    component: "OffchainDispatch",
                    action: "dispatch",
                    source: normalized.source,
                    orderId: normalized.orderId,
                    chainId: normalized.chainId,
                    collectionId: payload.collectionId,
                    sourceScopeKind: normalized.sourceScopeKind,
                });
            } else if (
                normalized.sourceScopeKind ===
                    ORDER_SOURCE_SCOPE_KIND.Attribute &&
                normalized.sourceCriteriaRoot &&
                normalized.sourceCriteriaRoot.toLowerCase() !==
                    resolved.merkleRoot.toLowerCase()
            ) {
                localTokenSetStatus = ORDER_LOCAL_TOKEN_SET_STATUS.Mismatch;
                logger.warn("Offchain token set criteria mismatch", {
                    component: "OffchainDispatch",
                    action: "dispatch",
                    source: normalized.source,
                    orderId: normalized.orderId,
                    chainId: normalized.chainId,
                    collectionId: payload.collectionId,
                    sourceScopeKind: normalized.sourceScopeKind,
                    expected: normalized.sourceCriteriaRoot,
                    resolved: resolved.merkleRoot,
                });
            } else {
                localTokenSetStatus = ORDER_LOCAL_TOKEN_SET_STATUS.Resolved;
                tokenSetId = resolved.tokenSetId;
                tokenSetSchemaHash = resolved.schemaHash;
            }
        }

        const upsertJob: JobEnvelope<OrderUpsertPayload> = {
            jobId: `orders:upsert:${normalized.chainId}:${normalized.orderId}:${payload.receivedAt}`,
            kind: ORDER_JOB_KIND.Upsert,
            queue: QUEUE_NAMES.OrdersUpsert,
            payload: {
                chainId: normalized.chainId,
                collectionId: payload.collectionId,
                orderId: normalized.orderId,
                kind: normalized.kind,
                side: normalized.side,
                maker: normalized.maker,
                taker: normalized.taker ?? null,
                contract: normalized.contract,
                tokenId: normalized.tokenId ?? null,
                sourceScopeKind: normalized.sourceScopeKind,
                sourceCriteriaRoot: normalized.sourceCriteriaRoot ?? null,
                sourceSchema: normalized.sourceSchema ?? null,
                localTokenSetStatus,
                tokenSetId,
                tokenSetSchemaHash,
                price: normalized.price ?? null,
                currency: normalized.currency ?? null,
                validFrom: normalized.validFrom ?? null,
                validUntil: normalized.validUntil ?? null,
                seaportData: normalized.seaportData ?? null,
                source: normalized.source,
                sourceStatus: "active",
                rawSourceKind: normalized.rawSourceKind,
                rawPayload: normalized.rawPayload,
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
                collectionId: payload.collectionId,
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
