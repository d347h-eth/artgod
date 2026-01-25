export type OffchainSourceEvent = {
    source: string;
    chainId: number;
    receivedAt: number;
    payload: unknown;
    eventId?: string;
};

export type OffchainSourceHandler = (
    event: OffchainSourceEvent,
) => Promise<void>;

export interface OffchainSourcePort {
    start(handler: OffchainSourceHandler): Promise<void>;
    stop(): Promise<void>;
}
