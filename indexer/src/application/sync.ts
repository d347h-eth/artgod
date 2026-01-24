import { decodeEventLog, encodeEventTopics, zeroAddress } from "viem";
import { ERC1155_ABI, ERC721_ABI } from "../abi/index.js";
import type { CollectionConfig } from "../config/index.js";
import type {
    EnhancedEvent,
    EnhancedTransaction,
    OnChainData,
    TransactionSummary,
    TransactionRecord,
} from "../domain/onchain.js";
import type { Hex, RpcLog, RpcProviderPort } from "../ports/rpc.js";
import { decodeSeaportFill } from "./fills/seaport.js";
import {
    decodeSeaportOrderEvents,
    getSeaportLogAddresses,
    SEAPORT_EVENT_FILTERS,
} from "./fills/seaport-events.js";

export type SyncRange = {
    fromBlock: number;
    toBlock: number;
};

const [ERC721_TRANSFER_TOPIC] = encodeEventTopics({
    abi: ERC721_ABI,
    eventName: "Transfer",
}) as [Hex];
const [ERC1155_TRANSFER_SINGLE_TOPIC] = encodeEventTopics({
    abi: ERC1155_ABI,
    eventName: "TransferSingle",
}) as [Hex];
const [ERC1155_TRANSFER_BATCH_TOPIC] = encodeEventTopics({
    abi: ERC1155_ABI,
    eventName: "TransferBatch",
}) as [Hex];
const TRANSFER_EVENTS = [
    ERC721_ABI[0],
    ERC1155_ABI[0],
    ERC1155_ABI[1],
] as const;

/**
 * Fetch logs for a block range and convert them into transaction-scoped transfer data.
 * Uses RpcProviderPort for log and transaction reads and keeps output minimal for MVP.
 */
export async function syncRange(
    rpc: RpcProviderPort,
    collections: CollectionConfig[],
    range: SyncRange,
): Promise<OnChainData> {
    const addresses = collections.map(
        (collection) => collection.address as Hex,
    );
    if (addresses.length === 0) {
        return {
            nftTransferEvents: [],
            nftBalanceDeltas: [],
            transactions: [],
            fillEvents: [],
            cancelEvents: [],
            orderInfos: [],
            makerInfos: [],
        };
    }

    // Query only transfer events for tracked collections within the range.
    const logs = await rpc.getLogs({
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        address: addresses.length === 1 ? addresses[0] : addresses,
        events: TRANSFER_EVENTS,
    });

    const seaportLogs = await rpc.getLogs({
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        address: getSeaportLogAddresses(),
        events: SEAPORT_EVENT_FILTERS,
    });

    const enhancedEvents: EnhancedEvent[] = [];
    for (const log of logs) {
        enhancedEvents.push(...decodeTransferLog(log));
    }

    const transactions = await buildEnhancedTransactions(rpc, enhancedEvents);
    const collectionSet = new Set(
        collections.map((collection) => collection.address.toLowerCase()),
    );
    const data = accumulateOnChainData(transactions, collectionSet);
    const seaportEvents = decodeSeaportOrderEvents(
        seaportLogs,
        collectionSet,
    );
    data.cancelEvents.push(...seaportEvents.cancels);
    data.orderInfos.push(...seaportEvents.orders);
    data.makerInfos.push(...seaportEvents.makerInfos);
    return data;
}

/**
 * Route a log to the correct transfer decoder based on topic0.
 * TransferBatch expands into multiple EnhancedEvent entries.
 */
function decodeTransferLog(log: RpcLog): EnhancedEvent[] {
    const topic0 = log.topics[0];
    if (!topic0) return [];

    if (topic0 === ERC721_TRANSFER_TOPIC) {
        return decodeErc721Transfer(log);
    }

    if (topic0 === ERC1155_TRANSFER_SINGLE_TOPIC) {
        return decodeErc1155TransferSingle(log);
    }

    if (topic0 === ERC1155_TRANSFER_BATCH_TOPIC) {
        return decodeErc1155TransferBatch(log);
    }

    return [];
}

/**
 * Decode a single ERC721 Transfer log into an EnhancedEvent.
 */
export function decodeErc721Transfer(log: RpcLog): EnhancedEvent[] {
    const topics = log.topics as [Hex, ...Hex[]];
    if (topics[0] !== ERC721_TRANSFER_TOPIC) return [];
    try {
        const decoded = decodeEventLog({
            abi: ERC721_ABI,
            eventName: "Transfer",
            data: log.data,
            topics,
        });
        const from = decoded.args.from as string;
        const to = decoded.args.to as string;
        const tokenId = decoded.args.tokenId as bigint;
        return [
            {
                base: {
                    contract: log.address,
                    blockNumber: log.blockNumber,
                    blockHash: log.blockHash,
                    txHash: log.transactionHash,
                    logIndex: log.logIndex,
                    batchIndex: 0,
                },
                decoded: {
                    standard: "erc721",
                    from: from,
                    to: to,
                    tokenId: tokenId.toString(),
                    amount: "1",
                },
                kind: "erc721",
            },
        ];
    } catch {
        return [];
    }
}

/**
 * Decode a single ERC1155 TransferSingle log into an EnhancedEvent.
 */
export function decodeErc1155TransferSingle(log: RpcLog): EnhancedEvent[] {
    const topics = log.topics as [Hex, ...Hex[]];
    if (topics[0] !== ERC1155_TRANSFER_SINGLE_TOPIC) return [];
    try {
        const decoded = decodeEventLog({
            abi: ERC1155_ABI,
            eventName: "TransferSingle",
            data: log.data,
            topics,
        });
        const from = decoded.args.from as string;
        const to = decoded.args.to as string;
        const tokenId = decoded.args.id as bigint;
        const value = decoded.args.value as bigint;
        return [
            {
                base: {
                    contract: log.address,
                    blockNumber: log.blockNumber,
                    blockHash: log.blockHash,
                    txHash: log.transactionHash,
                    logIndex: log.logIndex,
                    batchIndex: 0,
                },
                decoded: {
                    standard: "erc1155",
                    from: from,
                    to: to,
                    tokenId: tokenId.toString(),
                    amount: value.toString(),
                },
                kind: "erc1155",
            },
        ];
    } catch {
        return [];
    }
}

/**
 * Decode a single ERC1155 TransferBatch log into per-token EnhancedEvents.
 */
export function decodeErc1155TransferBatch(log: RpcLog): EnhancedEvent[] {
    const topics = log.topics as [Hex, ...Hex[]];
    if (topics[0] !== ERC1155_TRANSFER_BATCH_TOPIC) return [];
    try {
        const decoded = decodeEventLog({
            abi: ERC1155_ABI,
            eventName: "TransferBatch",
            data: log.data,
            topics,
        });
        const from = decoded.args.from as string;
        const to = decoded.args.to as string;
        const ids = decoded.args.ids as bigint[];
        const values = decoded.args.values as bigint[];
        const out: EnhancedEvent[] = [];
        for (let i = 0; i < ids.length; i += 1) {
            out.push({
                base: {
                    contract: log.address,
                    blockNumber: log.blockNumber,
                    blockHash: log.blockHash,
                    txHash: log.transactionHash,
                    logIndex: log.logIndex,
                    batchIndex: i,
                },
                decoded: {
                    standard: "erc1155",
                    from: from,
                    to: to,
                    tokenId: ids[i]?.toString() ?? "0",
                    amount: values[i]?.toString() ?? "0",
                },
                kind: "erc1155",
            });
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * Group events by tx hash, fetch each transaction once, and return ordered bundles.
 * Uses RpcProviderPort for transaction reads.
 */
async function buildEnhancedTransactions(
    rpc: RpcProviderPort,
    events: EnhancedEvent[],
): Promise<EnhancedTransaction[]> {
    if (events.length === 0) return [];

    const order: string[] = [];
    const grouped = new Map<string, EnhancedEvent[]>();
    for (const event of events) {
        const txHash = event.base.txHash;
        const existing = grouped.get(txHash);
        if (existing) {
            existing.push(event);
        } else {
            grouped.set(txHash, [event]);
            order.push(txHash);
        }
    }

    for (const group of grouped.values()) {
        group.sort(compareEvents);
    }

    const transactions = new Map<string, TransactionSummary>();
    const receipts = new Map<string, RpcLog[]>();
    for (const txHash of order) {
        const tx = await rpc.getTransaction(txHash);
        transactions.set(txHash, toTransactionSummary(tx));
        const receipt = await rpc.getTransactionReceipt(txHash);
        receipts.set(txHash, receipt.logs);
    }

    return order.map((txHash) => {
        const eventGroup = grouped.get(txHash) ?? [];
        const base = eventGroup[0]?.base;
        if (!base) {
            throw new Error(`Missing block attribution for tx ${txHash}`);
        }
        return {
            txHash,
            transaction: transactions.get(txHash)!,
            events: eventGroup,
            receiptLogs: receipts.get(txHash) ?? [],
            blockNumber: base.blockNumber,
            blockHash: base.blockHash,
        };
    });
}

/**
 * Convert transaction-scoped events into OnChainData for persistence.
 */
function accumulateOnChainData(
    transactions: EnhancedTransaction[],
    collections: Set<string>,
): OnChainData {
    const data: OnChainData = {
        nftTransferEvents: [],
        nftBalanceDeltas: [],
        transactions: [],
        fillEvents: [],
        cancelEvents: [],
        orderInfos: [],
        makerInfos: [],
    };

    for (const tx of transactions) {
        data.transactions.push(toTransactionRecord(tx));
        for (const event of tx.events) {
            const transfer = toTransferEvent(event);
            data.nftTransferEvents.push(transfer);
            pushBalanceDeltas(data, transfer);
        }
        // Seaport fills are decoded from calldata (no traces) and attached per tx.
        const fill = decodeSeaportFill(tx, collections);
        if (fill) {
            data.fillEvents.push(fill);
        }
    }

    // Maker triggers are derived from transfers for now (other triggers added later).
    data.makerInfos = deriveMakerInfosFromTransfers(data.nftTransferEvents);

    return data;
}

/**
 * Normalize an EnhancedEvent into the persisted transfer event shape.
 */
function toTransferEvent(
    event: EnhancedEvent,
): OnChainData["nftTransferEvents"][number] {
    return {
        contract: event.base.contract,
        from: event.decoded.from,
        to: event.decoded.to,
        tokenId: event.decoded.tokenId,
        amount: event.decoded.amount,
        blockNumber: event.base.blockNumber,
        blockHash: event.base.blockHash,
        txHash: event.base.txHash,
        logIndex: event.base.logIndex,
        kind: event.decoded.standard,
    };
}

/**
 * Convert an EnhancedTransaction into a persisted transaction record.
 */
function toTransactionRecord(tx: EnhancedTransaction): TransactionRecord {
    return {
        hash: tx.transaction.hash,
        from: tx.transaction.from,
        to: tx.transaction.to,
        input: tx.transaction.input,
        blockNumber: tx.blockNumber,
        blockHash: tx.blockHash,
    };
}

/**
 * Strip a raw RpcTransaction down to a serializable summary.
 */
function toTransactionSummary(tx: {
    hash: Hex;
    from: Hex;
    to: Hex | null;
    input: Hex;
}): TransactionSummary {
    return {
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        input: tx.input,
    };
}

/**
 * Sort events in on-chain order, including batch index for ERC1155 batches.
 */
function compareEvents(a: EnhancedEvent, b: EnhancedEvent): number {
    if (a.base.blockNumber !== b.base.blockNumber) {
        return a.base.blockNumber - b.base.blockNumber;
    }
    if (a.base.logIndex !== b.base.logIndex) {
        return a.base.logIndex - b.base.logIndex;
    }
    return (a.base.batchIndex ?? 0) - (b.base.batchIndex ?? 0);
}

/**
 * Translate a transfer event into +/- balance deltas (ignores zero address).
 */
function pushBalanceDeltas(
    data: OnChainData,
    event: OnChainData["nftTransferEvents"][number],
) {
    const amount = BigInt(event.amount);
    const zero = zeroAddress.toLowerCase();
    if (event.from.toLowerCase() !== zero) {
        data.nftBalanceDeltas.push({
            contract: event.contract,
            tokenId: event.tokenId,
            owner: event.from,
            delta: (-amount).toString(),
            blockNumber: event.blockNumber,
            txHash: event.txHash,
            logIndex: event.logIndex,
        });
    }
    if (event.to.toLowerCase() !== zero) {
        data.nftBalanceDeltas.push({
            contract: event.contract,
            tokenId: event.tokenId,
            owner: event.to,
            delta: amount.toString(),
            blockNumber: event.blockNumber,
            txHash: event.txHash,
            logIndex: event.logIndex,
        });
    }
}

/**
 * Derive maker triggers from transfer events.
 * Maker triggers are not cancels: they request order fillability re-validation.
 */
function deriveMakerInfosFromTransfers(
    transfers: OnChainData["nftTransferEvents"],
): OnChainData["makerInfos"] {
    const out: OnChainData["makerInfos"] = [];
    const zero = zeroAddress.toLowerCase();
    for (const event of transfers) {
        const from = event.from.toLowerCase();
        if (from === zero) continue;
        out.push({
            maker: from,
            contract: event.contract,
            tokenId: event.tokenId,
            reason: "nft-transfer",
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            txHash: event.txHash,
            logIndex: event.logIndex,
        });
    }
    return out;
}
