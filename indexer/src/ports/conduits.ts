export type ConduitRecord = {
    chainId: number;
    conduitKey: string;
    conduitAddress: string;
    updatedAt?: string | null;
};

export interface ConduitRegistryPort {
    getConduit(chainId: number, conduitKey: string): string | null;
    upsertConduit(record: ConduitRecord): void;
    hasChannel(
        chainId: number,
        conduitAddress: string,
        channelAddress: string,
    ): boolean;
    replaceChannels(
        chainId: number,
        conduitAddress: string,
        channels: string[],
    ): void;
}
