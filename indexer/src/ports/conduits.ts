export type ConduitRecord = {
    chainId: number;
    conduitKey: string;
    conduitAddress: string;
    updatedAt?: string | null;
};

export interface ConduitRegistryPort {
    getConduit(chainId: number, conduitKey: string): string | null;
    upsertConduit(record: ConduitRecord): void;
}
