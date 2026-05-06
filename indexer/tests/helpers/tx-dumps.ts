import fs from "node:fs/promises";
import {
    decodeErc1155TransferBatch,
    decodeErc1155TransferSingle,
    decodeErc721Transfer,
} from "../../src/application/sync.js";
import type {
    EnhancedEvent,
    EnhancedTransaction,
} from "../../src/domain/onchain.js";
import type { Hex, RpcLog } from "../../src/ports/rpc.js";
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
        events.push(
            ...decodeErc721Transfer(rpcLog),
            ...decodeErc1155TransferSingle(rpcLog),
            ...decodeErc1155TransferBatch(rpcLog),
        );
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
