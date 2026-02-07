import type {
    DomainSyncMode,
    MetadataRefreshPayload,
    MetadataStatsRecomputePayload,
} from "../domain/domain-jobs.js";
import type {
    OrderUpdateByIdPayload,
    OrderUpdateByMakerPayload,
    OrderUpsertPayload,
} from "../domain/order-jobs.js";

export type DomainSyncContext = {
    chainId: number;
    fromBlock: number;
    toBlock: number;
    mode: DomainSyncMode;
    sourceJobId: string;
    sourceKind: string;
};

export interface OrdersDomainPort {
    handleDomainSync(context: DomainSyncContext): Promise<void>;
    handleOrderUpdateByMaker(payload: OrderUpdateByMakerPayload): Promise<void>;
    handleOrderUpdateById(payload: OrderUpdateByIdPayload): Promise<void>;
    handleOrderUpsert(payload: OrderUpsertPayload): Promise<void>;
}

export interface MetadataDomainPort {
    handleDomainSync(context: DomainSyncContext): Promise<string[]>;
    handleMetadataRefresh(payload: MetadataRefreshPayload): Promise<boolean>;
}

export interface MetadataStatsDomainPort {
    handleRecompute(payload: MetadataStatsRecomputePayload): Promise<void>;
}

export interface ActivityDomainPort {
    handleDomainSync(context: DomainSyncContext): Promise<void>;
}
