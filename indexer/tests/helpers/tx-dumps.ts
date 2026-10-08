import fs from "node:fs/promises";
import { encodeEventTopics } from "viem";
import { decodeNftTransferLog } from "../../src/application/nft-transfers.js";
import type {
    EnhancedEvent,
    EnhancedTransaction,
} from "../../src/domain/onchain.js";
import type {
    Hex,
    RpcBlock,
    RpcLog,
    RpcProviderPort,
} from "../../src/ports/rpc.js";
import { resolveFixturePath } from "./fixture-paths.js";

export type TxDumpLog = {
    address: Hex;
    data: Hex;
    topics: Hex[];
    blockNumber: string | number;
    blockHash: Hex;
    transactionHash: Hex;
    logIndex: number;
};

export type TxDump = {
    tx: {
        hash: string;
        from: string;
        to: string | null;
        input: Hex;
        blockNumber: string | number;
        blockHash: string;
    };
    receipt?: {
        logs?: TxDumpLog[];
    };
};

export async function readTxDump(
    importMetaUrl: string,
    fixtureDirectory: string,
    file: string,
): Promise<TxDump> {
    const resolved = resolveFixturePath(importMetaUrl, fixtureDirectory, file);
    const raw = await fs.readFile(resolved, "utf8");
    return JSON.parse(raw) as TxDump;
}

export function toEnhancedTransaction(dump: TxDump): EnhancedTransaction {
    const receiptLogs = toReceiptLogs(dump);
    return {
        txHash: dump.tx.hash,
        transaction: {
            hash: dump.tx.hash,
            from: dump.tx.from,
            to: dump.tx.to,
            input: dump.tx.input,
        },
        events: extractTransferEvents(dump),
        receiptLogs,
        blockNumber: Number(dump.tx.blockNumber),
        blockHash: dump.tx.blockHash,
    };
}

function extractTransferEvents(dump: TxDump): EnhancedEvent[] {
    const logs = dump.receipt?.logs ?? [];
    const events: EnhancedEvent[] = [];
    for (const log of logs) {
        const rpcLog = toRpcLog(log);
        events.push(...decodeNftTransferLog(rpcLog));
    }
    return events;
}

function toReceiptLogs(dump: TxDump): RpcLog[] {
    const logs = dump.receipt?.logs ?? [];
    return logs.map(toRpcLog);
}

function toRpcLog(log: TxDumpLog): RpcLog {
    return {
        address: log.address,
        data: log.data,
        topics: log.topics,
        blockNumber: Number(log.blockNumber),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
    };
}

/** Serve public receipt fixtures through the production sync port. An
 * unexpected read fails instead of consulting a configured live endpoint. */
export function createTxDumpRpc(
    tx: EnhancedTransaction,
    block: RpcBlock,
): RpcProviderPort {
    const unsupported = async (): Promise<never> => {
        throw new Error("Unexpected RPC read in fixture-backed sale sync");
    };
    return {
        getBlockNumber: async () => block.number,
        getBlock: async () => block,
        getTransaction: async () => ({
            ...tx.transaction,
            hash: tx.txHash as Hex,
            from: tx.transaction.from as Hex,
            to: tx.transaction.to as Hex | null,
        }),
        getTransactionReceipt: async () => ({
            transactionHash: tx.txHash as Hex,
            logs: tx.receiptLogs,
        }),
        getLogs: async (filter) => {
            const addresses =
                typeof filter.address === "string"
                    ? [filter.address]
                    : filter.address;
            const topics = filter.events?.map(
                (event) =>
                    encodeEventTopics({
                        abi: [event],
                        eventName: event.name,
                    })[0],
            );
            return tx.receiptLogs.filter(
                (log) =>
                    log.blockNumber >= filter.fromBlock &&
                    log.blockNumber <= filter.toBlock &&
                    (!addresses ||
                        addresses.some(
                            (address) =>
                                address.toLowerCase() ===
                                log.address.toLowerCase(),
                        )) &&
                    (!topics || topics.includes(log.topics[0])),
            );
        },
        readContract: unsupported,
        getBalance: unsupported,
    };
}
