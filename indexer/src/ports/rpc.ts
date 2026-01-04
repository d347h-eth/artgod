export type RpcLogFilter = {
    fromBlock: number;
    toBlock: number;
    address?: string | string[];
    topics?: Array<string | string[] | null>;
};

export type RpcBlock = {
    number: number;
    hash: string;
    parentHash: string;
    timestamp: number;
    transactions: string[];
};

export type RpcTransaction = {
    hash: string;
    from: string;
    to: string | null;
    input: string;
};

export type RpcLog = {
    address: string;
    data: string;
    topics: string[];
    blockNumber: number;
    blockHash: string;
    transactionHash: string;
    logIndex: number;
};

export interface RpcProviderPort {
    getBlockNumber(): Promise<number>;
    getBlock(blockNumber: number): Promise<RpcBlock>;
    getLogs(filter: RpcLogFilter): Promise<RpcLog[]>;
    getTransaction(txHash: string): Promise<RpcTransaction>;
}
