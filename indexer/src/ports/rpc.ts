export type Hex = `0x${string}`;

export type RpcEvent = {
    type: "event";
    name: string;
    inputs: readonly {
        indexed?: boolean;
        name: string;
        type: string;
    }[];
    anonymous?: boolean;
};

export type RpcLogFilter = {
    fromBlock: number;
    toBlock: number;
    address?: Hex | Hex[];
    events?: readonly RpcEvent[];
};

export type RpcBlock = {
    number: number;
    hash: Hex;
    parentHash: Hex;
    timestamp: number;
    transactions: Hex[];
};

export type RpcTransaction = {
    hash: Hex;
    from: Hex;
    to: Hex | null;
    input: Hex;
};

export type RpcTransactionReceipt = {
    transactionHash: Hex;
    logs: RpcLog[];
};

export type RpcLog = {
    address: Hex;
    data: Hex;
    topics: Hex[];
    blockNumber: number;
    blockHash: Hex;
    transactionHash: Hex;
    logIndex: number;
};

export interface RpcProviderPort {
    getBlockNumber(): Promise<number>;
    getBlock(blockNumber: number): Promise<RpcBlock>;
    getLogs(filter: RpcLogFilter): Promise<RpcLog[]>;
    getTransaction(txHash: string): Promise<RpcTransaction>;
    getTransactionReceipt(txHash: string): Promise<RpcTransactionReceipt>;
    readContract<T = unknown>(params: {
        address: Hex;
        abi: readonly unknown[];
        functionName: string;
        args?: readonly unknown[];
        blockNumber?: number;
    }): Promise<T>;
}
