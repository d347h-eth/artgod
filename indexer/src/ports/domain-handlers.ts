import type { ActivityUpsertPayload } from "../domain/activity-jobs.js";
import type {
    DomainSyncProjection,
    DomainSyncMode,
    MetadataRefreshPayload,
    MetadataStatsRecomputePayload,
} from "../domain/domain-jobs.js";
import type {
    MetadataDomainSyncResult,
    MetadataRefreshResult,
} from "../domain/metadata.js";
import type {
    OrderUpdateByIdPayload,
    OrderUpdateByMakerPayload,
    OrderUpsertPayload,
} from "../domain/order-jobs.js";

export type DomainSyncContext = {
    chainId: number;
    collectionId: number | null;
    fromBlock: number;
    toBlock: number;
    mode: DomainSyncMode;
    projection: DomainSyncProjection;
    sourceJobId: string;
    sourceKind: string;
};

export type OrderUpdateByMakerRuntimeContext = {
    jobId: string;
    attempt: number;
    scheduledAt: number;
    traceId?: string | null;
    consumerName?: string;
};

export interface OrdersDomainPort {
    handleDomainSync(context: DomainSyncContext): Promise<void>;
    handleOrderUpdateByMaker(
        payload: OrderUpdateByMakerPayload,
        context?: OrderUpdateByMakerRuntimeContext,
    ): Promise<void>;
    handleOrderUpdateById(payload: OrderUpdateByIdPayload): Promise<void>;
    handleOrderUpsert(payload: OrderUpsertPayload): Promise<void>;
}

export interface MetadataDomainPort {
    handleDomainSync(
        context: DomainSyncContext,
    ): Promise<MetadataDomainSyncResult>;
    handleMetadataRefresh(
        payload: MetadataRefreshPayload,
    ): Promise<MetadataRefreshResult>;
}

export interface MetadataStatsDomainPort {
    handleRecompute(payload: MetadataStatsRecomputePayload): Promise<void>;
}

export interface ActivityDomainPort {
    handleDomainSync(context: DomainSyncContext): Promise<void>;
    handleActivityUpsert(payload: ActivityUpsertPayload): Promise<void>;
}
