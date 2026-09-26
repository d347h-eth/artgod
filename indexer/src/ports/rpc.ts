export type Hex = `0x${string}`;

/** Upper bound for one optional aggregate call, independent of provider retries. */
export const RPC_CONTRACT_BATCH_MAX_CALLS = 20;

export type RpcContractRead = {
    address: Hex;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
};

export type RpcContractReadResult = { value: unknown } | { error: unknown };

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
    getBlock(
        blockNumber: number,
        options?: { fresh: boolean },
    ): Promise<RpcBlock>;
    getLogs(filter: RpcLogFilter): Promise<RpcLog[]>;
    getTransaction(txHash: string): Promise<RpcTransaction>;
    getTransactionReceipt(txHash: string): Promise<RpcTransactionReceipt>;
    readContract<T = unknown>(
        params: RpcContractRead & { blockNumber?: number },
    ): Promise<T>;
    /**
     * Optional bounded aggregate at one explicit block, with positional results.
     * Only use for views independent of msg.sender; aggregation changes the caller.
     * Infrastructure failures may reject the whole call. Callers own safe fallback.
     */
    readContracts?(input: {
        contracts: readonly RpcContractRead[];
        blockNumber: number;
    }): Promise<readonly RpcContractReadResult[]>;
    getBalance(
        address: Hex,
        options?: { blockNumber: number },
    ): Promise<bigint>;
}
