import type { ChainBlockReference } from "../domain/chain-sync.js";

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
    event?: RpcEvent;
    args?: Readonly<Record<string, unknown>>;
};

export type RpcFirstLogPage = {
    log: RpcLog | null;
    // Only a successfully fetched page advances the durable search cursor.
    nextBlock: number;
};

export type RpcLogRequestHooks = {
    // Checked before retry/circuit admission and again after quota waiting.
    beforeRequest?: () => void;
    onRequest?: (range: { fromBlock: number; toBlock: number }) => void;
};

// Search one bounded page. Callers own the durable cursor and yield between pages.
export interface RpcFirstLogPort {
    findFirstLogPage(
        filter: RpcLogFilter & { address: Hex; event: RpcEvent },
        hooks?: RpcLogRequestHooks,
    ): Promise<RpcFirstLogPage>;
}

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
    blockNumber: number;
    blockHash: Hex;
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
    getBlockNumber(beforeRequest?: () => void): Promise<number>;
    getBlock(
        blockNumber: number,
        options?: { fresh: boolean; beforeRequest?: () => void },
    ): Promise<RpcBlock>;
    getLogs(filter: RpcLogFilter): Promise<RpcLog[]>;
    getTransaction(txHash: string): Promise<RpcTransaction>;
    // Sync must bypass cached receipts when a transaction can move across a reorg.
    getTransactionReceipt(
        txHash: string,
        options?: { fresh: boolean },
    ): Promise<RpcTransactionReceipt>;
    readContract<T = unknown>(
        params: RpcContractRead & { blockNumber?: number },
    ): Promise<T>;
    // Read state at this exact canonical hash or reject. Endpoint retries must
    // retain the hash; unsupported/unavailable blocks are not contract absence.
    readContractAtBlock<T = unknown>(
        params: RpcContractRead & { block: ChainBlockReference },
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
    /** Optional aggregate with the same exact-hash guarantee as a single read. */
    readContractsAtBlock?(input: {
        contracts: readonly RpcContractRead[];
        block: ChainBlockReference;
    }): Promise<readonly RpcContractReadResult[]>;
    /** Native balances obey the same block identity as contract state. */
    getBalanceAtBlock(
        address: Hex,
        block: ChainBlockReference,
    ): Promise<bigint>;
    getBalance(
        address: Hex,
        options?: { blockNumber: number },
    ): Promise<bigint>;
}
