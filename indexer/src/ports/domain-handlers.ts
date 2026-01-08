import type { DomainSyncMode } from "../domain/domain-jobs.js";

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
}

export interface MetadataDomainPort {
    handleDomainSync(context: DomainSyncContext): Promise<void>;
}

export interface ActivityDomainPort {
    handleDomainSync(context: DomainSyncContext): Promise<void>;
}
