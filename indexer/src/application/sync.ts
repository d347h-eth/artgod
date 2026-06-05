import { decodeEventLog, encodeEventTopics, zeroAddress } from "viem";
import { ERC1155_ABI, ERC721_ABI } from "../abi/index.js";
import type { CollectionRecord } from "../domain/collections.js";
import {
    COLLECTION_SCOPED_MAKER_TRIGGER_REASON,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
} from "../domain/maker-triggers.js";
import type {
    EnhancedEvent,
    EnhancedTransaction,
    OnChainData,
    TransactionSummary,
    TransactionRecord,
} from "../domain/onchain.js";
import type { CollectionScopeResolverPort } from "../ports/collections.js";
import type { Hex, RpcLog, RpcProviderPort } from "../ports/rpc.js";
import { decodeBlurFills } from "./fills/blur.js";
import { decodeSeaportFills } from "./fills/seaport.js";
import type { DecodedFillEvent } from "./fills/types.js";
import type { CollectionExtensionSyncWatchSpec } from "./collection-extensions/types.js";
import {
    decodeMetadataRefreshLog,
    type DecodedMetadataRefreshEvent,
    type DecodedMetadataRefreshRangeEvent,
    METADATA_REFRESH_EVENT_FILTERS,
} from "./metadata/refresh-triggers.js";
import {
    decodeSeaportOrderEvents,
    getSeaportLogAddresses,
    SEAPORT_EVENT_FILTERS,
    type DecodedOrderInfo,
} from "./fills/seaport-events.js";

export type SyncRange = {
    fromBlock: number;
    toBlock: number;
};

const [ERC721_TRANSFER_TOPIC] = encodeEventTopics({
    abi: ERC721_ABI,
    eventName: "Transfer",
}) as [Hex];
const [ERC721_APPROVAL_TOPIC] = encodeEventTopics({
    abi: ERC721_ABI,
    eventName: "Approval",
}) as [Hex];
const [ERC721_APPROVAL_FOR_ALL_TOPIC] = encodeEventTopics({
    abi: ERC721_ABI,
    eventName: "ApprovalForAll",
}) as [Hex];
const [ERC1155_TRANSFER_SINGLE_TOPIC] = encodeEventTopics({
    abi: ERC1155_ABI,
    eventName: "TransferSingle",
}) as [Hex];
const [ERC1155_TRANSFER_BATCH_TOPIC] = encodeEventTopics({
    abi: ERC1155_ABI,
    eventName: "TransferBatch",
}) as [Hex];
const ERC721_TRANSFER_EVENT = ERC721_ABI[0];
const ERC721_APPROVAL_EVENT = ERC721_ABI[1];
const ERC721_APPROVAL_FOR_ALL_EVENT = ERC721_ABI[2];
const ERC1155_TRANSFER_SINGLE_EVENT = ERC1155_ABI[0];
const ERC1155_TRANSFER_BATCH_EVENT = ERC1155_ABI[1];
const TRANSFER_EVENTS = [
    ERC721_TRANSFER_EVENT,
    ERC1155_TRANSFER_SINGLE_EVENT,
    ERC1155_TRANSFER_BATCH_EVENT,
] as const;
const NFT_APPROVAL_EVENTS = [
    ERC721_APPROVAL_EVENT,
    ERC721_APPROVAL_FOR_ALL_EVENT,
] as const;

/**
 * Fetch logs for a block range and convert them into transaction-scoped transfer data.
 * Uses RpcProviderPort for log and transaction reads and keeps output minimal for MVP.
 */
export async function syncRange(
    rpc: RpcProviderPort,
    chainId: number,
    collections: CollectionRecord[],
    collectionScopeResolver: CollectionScopeResolverPort,
    range: SyncRange,
    collectionExtensionWatchSpecs: CollectionExtensionSyncWatchSpec[] = [],
): Promise<OnChainData> {
    const addresses = collections.map(
        (collection) => collection.address as Hex,
    );
    if (addresses.length === 0) {
        return {
            transactions: [],
            collectionScoped: {
                nftTransferEvents: [],
                nftApprovalEvents: [],
                nftBalanceDeltas: [],
                fillEvents: [],
                orderInfos: [],
                makerTriggers: [],
                metadataRefreshEvents: [],
                metadataRefreshRangeEvents: [],
                collectionExtensionEvents: [],
                collectionExtensionEventMedia: [],
            },
            global: {
                cancelEvents: [],
                makerTriggers: [],
            },
        };
    }

    // Query only transfer events for tracked collections within the range.
    const logs = await rpc.getLogs({
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        address: addresses.length === 1 ? addresses[0] : addresses,
        events: TRANSFER_EVENTS,
    });

    // NFT approvals change sell-order executability without changing ownership.
    const nftApprovalLogs = await rpc.getLogs({
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        address: addresses.length === 1 ? addresses[0] : addresses,
        events: NFT_APPROVAL_EVENTS,
    });

    // Metadata refresh triggers (e.g. ERC-4906) for tracked collections.
    const metadataRefreshLogs = await rpc.getLogs({
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        address: addresses.length === 1 ? addresses[0] : addresses,
        events: METADATA_REFRESH_EVENT_FILTERS,
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

    const trackedContracts = new Set(
        collections.map((collection) => collection.address.toLowerCase()),
    );
    const resolutionContext: CollectionResolutionContext = {
        chainId,
        collections,
        trackedContracts,
        collectionScopeResolver,
    };
    const nftApprovalEvents = resolveNftApprovalEvents(
        nftApprovalLogs.flatMap(decodeNftApprovalLog),
        resolutionContext,
    );

    const metadataRefreshEvents: DecodedMetadataRefreshEvent[] = [];
    const metadataRefreshRangeEvents: DecodedMetadataRefreshRangeEvent[] = [];
    const extensionMetadataRefreshEvents: OnChainData["collectionScoped"]["metadataRefreshEvents"] =
        [];
    const extensionMetadataRefreshRangeEvents: OnChainData["collectionScoped"]["metadataRefreshRangeEvents"] =
        [];
    const collectionExtensionEvents: OnChainData["collectionScoped"]["collectionExtensionEvents"] =
        [];
    const collectionExtensionEventMedia: OnChainData["collectionScoped"]["collectionExtensionEventMedia"] =
        [];
    for (const log of metadataRefreshLogs) {
        const decoded = decodeMetadataRefreshLog(log);
        metadataRefreshEvents.push(...decoded.tokenEvents);
        metadataRefreshRangeEvents.push(...decoded.rangeEvents);
    }
    for (const spec of collectionExtensionWatchSpecs) {
        const logs = await rpc.getLogs({
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            address: spec.address,
            events: spec.events,
        });
        for (const log of logs) {
            // Let the extension enrich logs with any block-scoped reads it owns.
            const decoded = await spec.decode(log, { rpc });
            extensionMetadataRefreshEvents.push(
                ...decoded.metadataRefreshEvents,
            );
            extensionMetadataRefreshRangeEvents.push(
                ...decoded.metadataRefreshRangeEvents,
            );
            collectionExtensionEvents.push(
                ...decoded.collectionExtensionEvents,
            );
            collectionExtensionEventMedia.push(
                ...decoded.collectionExtensionEventMedia,
            );
        }
    }

    const transactions = await buildEnhancedTransactions(rpc, enhancedEvents);
    const data = accumulateOnChainData(transactions, resolutionContext);
    data.collectionScoped.nftApprovalEvents.push(...nftApprovalEvents);
    data.collectionScoped.makerTriggers.push(
        ...deriveMakerTriggersFromNftApprovals(nftApprovalEvents),
    );
    data.collectionScoped.metadataRefreshEvents = [
        ...resolveMetadataRefreshEvents(
            metadataRefreshEvents,
            resolutionContext,
        ),
        ...extensionMetadataRefreshEvents,
    ];
    data.collectionScoped.metadataRefreshRangeEvents = [
        ...resolveMetadataRefreshRangeEvents(
            metadataRefreshRangeEvents,
            resolutionContext,
        ),
        ...extensionMetadataRefreshRangeEvents,
    ];
    data.collectionScoped.collectionExtensionEvents.push(
        ...collectionExtensionEvents,
    );
    data.collectionScoped.collectionExtensionEventMedia.push(
        ...collectionExtensionEventMedia,
    );
    const seaportEvents = decodeSeaportOrderEvents(
        seaportLogs,
        trackedContracts,
    );
    data.global.cancelEvents.push(...seaportEvents.cancels);
    for (const order of seaportEvents.orders) {
        const resolved = resolveOrderInfo(order, resolutionContext);
        if (resolved) {
            data.collectionScoped.orderInfos.push(resolved);
        }
    }
    data.global.makerTriggers.push(...seaportEvents.globalMakerTriggers);
    return data;
}

type CollectionResolutionContext = {
    chainId: number;
    collections: CollectionRecord[];
    trackedContracts: Set<string>;
    collectionScopeResolver: CollectionScopeResolverPort;
};

export type DecodedNftApprovalLog =
    | {
          scope: "token";
          contract: string;
          owner: string;
          operator: string;
          tokenId: string;
          kind: "erc721";
          blockNumber: number;
          blockHash: string;
          txHash: string;
          logIndex: number;
      }
    | {
          scope: "collection";
          contract: string;
          owner: string;
          operator: string;
          approved: boolean;
          kind?: "erc721" | "erc1155";
          blockNumber: number;
          blockHash: string;
          txHash: string;
          logIndex: number;
      };

/** Collection-level operator approval decoded before collection resolution. */
export type DecodedNftApprovalForAllLog = Extract<
    DecodedNftApprovalLog,
    { scope: "collection" }
>;

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
 * Route NFT approval logs to the matching approval decoder.
 */
export function decodeNftApprovalLog(log: RpcLog): DecodedNftApprovalLog[] {
    const topic0 = log.topics[0];
    if (!topic0) return [];

    if (topic0 === ERC721_APPROVAL_TOPIC) {
        return decodeErc721Approval(log);
    }

    if (topic0 === ERC721_APPROVAL_FOR_ALL_TOPIC) {
        return decodeNftApprovalForAll(log);
    }

    return [];
}

/**
 * Decode a single ERC721 token approval log.
 */
export function decodeErc721Approval(log: RpcLog): DecodedNftApprovalLog[] {
    const topics = log.topics as [Hex, ...Hex[]];
    if (topics[0] !== ERC721_APPROVAL_TOPIC) return [];
    try {
        const decoded = decodeEventLog({
            abi: ERC721_ABI,
            eventName: "Approval",
            data: log.data,
            topics,
        });
        const owner = decoded.args.owner as string;
        const operator = decoded.args.approved as string;
        const tokenId = decoded.args.tokenId as bigint;
        return [
            {
                scope: "token",
                contract: log.address,
                owner,
                operator,
                tokenId: tokenId.toString(),
                kind: "erc721",
                blockNumber: log.blockNumber,
                blockHash: log.blockHash,
                txHash: log.transactionHash,
                logIndex: log.logIndex,
            },
        ];
    } catch {
        return [];
    }
}

/**
 * Decode a collection operator approval log.
 * ERC721 and ERC1155 ApprovalForAll have the same event signature, so the
 * collection standard is applied later from the resolved collection context.
 */
export function decodeNftApprovalForAll(
    log: RpcLog,
): DecodedNftApprovalForAllLog[] {
    const topics = log.topics as [Hex, ...Hex[]];
    if (topics[0] !== ERC721_APPROVAL_FOR_ALL_TOPIC) return [];
    try {
        const decoded = decodeEventLog({
            abi: ERC721_ABI,
            eventName: "ApprovalForAll",
            data: log.data,
            topics,
        });
        return [
            {
                scope: "collection",
                contract: log.address,
                owner: decoded.args.owner as string,
                operator: decoded.args.operator as string,
                approved: decoded.args.approved as boolean,
                blockNumber: log.blockNumber,
                blockHash: log.blockHash,
                txHash: log.transactionHash,
                logIndex: log.logIndex,
            },
        ];
    } catch {
        return [];
    }
}

/**
 * Decode a single ERC721 collection operator approval log.
 */
export function decodeErc721ApprovalForAll(
    log: RpcLog,
): DecodedNftApprovalLog[] {
    return decodeNftApprovalForAll(log).map((event) => ({
        ...event,
        kind: "erc721",
    }));
}

/**
 * Decode a single ERC1155 collection operator approval log.
 */
export function decodeErc1155ApprovalForAll(
    log: RpcLog,
): DecodedNftApprovalLog[] {
    return decodeNftApprovalForAll(log).map((event) => ({
        ...event,
        kind: "erc1155",
    }));
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
    resolutionContext: CollectionResolutionContext,
): OnChainData {
    const data: OnChainData = {
        transactions: [],
        collectionScoped: {
            nftTransferEvents: [],
            nftApprovalEvents: [],
            nftBalanceDeltas: [],
            fillEvents: [],
            orderInfos: [],
            makerTriggers: [],
            metadataRefreshEvents: [],
            metadataRefreshRangeEvents: [],
            collectionExtensionEvents: [],
            collectionExtensionEventMedia: [],
        },
        global: {
            cancelEvents: [],
            makerTriggers: [],
        },
    };

    for (const tx of transactions) {
        data.transactions.push(toTransactionRecord(tx));
        for (const event of tx.events) {
            const transfer = toTransferEvent(event, resolutionContext);
            if (!transfer) {
                continue;
            }
            data.collectionScoped.nftTransferEvents.push(transfer);
            pushBalanceDeltas(data, transfer);
        }
        // Fill decoders use tx calldata plus receipt logs; no trace namespace required.
        const fills = [
            ...decodeSeaportFills(tx, resolutionContext.trackedContracts),
            ...decodeBlurFills(tx, resolutionContext.trackedContracts),
        ];
        for (const fill of fills) {
            const resolved = resolveFillEvent(fill, resolutionContext);
            if (resolved) {
                data.collectionScoped.fillEvents.push(resolved);
            }
        }
    }

    // Ownership-driven maker triggers are collection-scoped and derived from
    // transfers. Broader maker triggers are appended separately by callers.
    data.collectionScoped.makerTriggers =
        deriveTokenScopedMakerTriggersFromTransfers(
            data.collectionScoped.nftTransferEvents,
        );

    return data;
}

/**
 * Normalize an EnhancedEvent into the persisted transfer event shape.
 */
function toTransferEvent(
    event: EnhancedEvent,
    resolutionContext: CollectionResolutionContext,
): OnChainData["collectionScoped"]["nftTransferEvents"][number] | null {
    const contract = event.base.contract.toLowerCase();
    const collectionId = resolveCollectionId(
        resolutionContext,
        contract,
        event.decoded.tokenId,
    );
    if (collectionId === null) {
        return null;
    }
    return {
        collectionId,
        contract,
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
    event: OnChainData["collectionScoped"]["nftTransferEvents"][number],
) {
    const amount = BigInt(event.amount);
    const zero = zeroAddress.toLowerCase();
    if (event.from.toLowerCase() !== zero) {
        data.collectionScoped.nftBalanceDeltas.push({
            collectionId: event.collectionId,
            contract: event.contract,
            tokenId: event.tokenId,
            owner: event.from,
            delta: (-amount).toString(),
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            txHash: event.txHash,
            logIndex: event.logIndex,
        });
    }
    if (event.to.toLowerCase() !== zero) {
        data.collectionScoped.nftBalanceDeltas.push({
            collectionId: event.collectionId,
            contract: event.contract,
            tokenId: event.tokenId,
            owner: event.to,
            delta: amount.toString(),
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            txHash: event.txHash,
            logIndex: event.logIndex,
        });
    }
}

/**
 * Derive maker triggers from transfer events.
 * Maker triggers are not cancels: they request order fillability re-validation.
 */
function deriveTokenScopedMakerTriggersFromTransfers(
    transfers: OnChainData["collectionScoped"]["nftTransferEvents"],
): OnChainData["collectionScoped"]["makerTriggers"] {
    const out: OnChainData["collectionScoped"]["makerTriggers"] = [];
    const zero = zeroAddress.toLowerCase();
    for (const event of transfers) {
        const from = event.from.toLowerCase();
        if (from === zero) continue;
        out.push({
            maker: from,
            collectionId: event.collectionId,
            contract: event.contract,
            tokenId: event.tokenId,
            reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            txHash: event.txHash,
            logIndex: event.logIndex,
        });
    }
    return out;
}

function resolveNftApprovalEvents(
    events: DecodedNftApprovalLog[],
    resolutionContext: CollectionResolutionContext,
): OnChainData["collectionScoped"]["nftApprovalEvents"] {
    const resolved: OnChainData["collectionScoped"]["nftApprovalEvents"] = [];

    for (const event of events) {
        const contract = event.contract.toLowerCase();
        if (!resolutionContext.trackedContracts.has(contract)) {
            continue;
        }

        if (event.scope === "token") {
            const collectionId = resolveCollectionId(
                resolutionContext,
                contract,
                event.tokenId,
            );
            if (collectionId === null) {
                continue;
            }
            resolved.push({
                ...event,
                collectionId,
                contract,
                owner: event.owner.toLowerCase(),
                operator: event.operator.toLowerCase(),
            });
            continue;
        }

        const collectionIds =
            resolutionContext.collectionScopeResolver.resolveContractScopedCollectionIds(
                resolutionContext.chainId,
                resolutionContext.collections,
                contract,
            );
        for (const collectionId of collectionIds) {
            const collection = resolutionContext.collections.find(
                (candidate) => candidate.id === collectionId,
            );
            if (!collection) {
                continue;
            }
            resolved.push({
                ...event,
                collectionId,
                contract,
                kind: event.kind ?? collection.standard,
                owner: event.owner.toLowerCase(),
                operator: event.operator.toLowerCase(),
            });
        }
    }

    return resolved;
}

function deriveMakerTriggersFromNftApprovals(
    events: OnChainData["collectionScoped"]["nftApprovalEvents"],
): OnChainData["collectionScoped"]["makerTriggers"] {
    const out: OnChainData["collectionScoped"]["makerTriggers"] = [];

    for (const event of events) {
        if (event.scope === "token") {
            out.push({
                maker: event.owner,
                collectionId: event.collectionId,
                contract: event.contract,
                tokenId: event.tokenId,
                reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftApproval,
                blockNumber: event.blockNumber,
                blockHash: event.blockHash,
                txHash: event.txHash,
                logIndex: event.logIndex,
            });
            continue;
        }

        out.push({
            maker: event.owner,
            collectionId: event.collectionId,
            contract: event.contract,
            reason: COLLECTION_SCOPED_MAKER_TRIGGER_REASON.NftApprovalForAll,
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            txHash: event.txHash,
            logIndex: event.logIndex,
        });
    }

    return out;
}

function resolveCollectionId(
    resolutionContext: CollectionResolutionContext,
    contract: string,
    tokenId: string,
): number | null {
    if (!resolutionContext.trackedContracts.has(contract.toLowerCase())) {
        return null;
    }

    return resolutionContext.collectionScopeResolver.resolveTokenScopedCollectionId(
        resolutionContext.chainId,
        resolutionContext.collections,
        contract,
        tokenId,
    );
}

function resolveFillEvent(
    fill: DecodedFillEvent,
    resolutionContext: CollectionResolutionContext,
): OnChainData["collectionScoped"]["fillEvents"][number] | null {
    const contract = fill.contract.toLowerCase();
    const collectionId = resolveCollectionId(
        resolutionContext,
        contract,
        fill.tokenId,
    );
    if (collectionId === null) {
        return null;
    }

    return {
        collectionId,
        ...fill,
        contract,
    };
}

function resolveOrderInfo(
    order: DecodedOrderInfo,
    resolutionContext: CollectionResolutionContext,
): OnChainData["collectionScoped"]["orderInfos"][number] | null {
    const contract = order.contract.toLowerCase();
    const collectionId = resolveCollectionId(
        resolutionContext,
        contract,
        order.tokenId,
    );
    if (collectionId === null) {
        return null;
    }

    return {
        collectionId,
        ...order,
        contract,
    };
}

function resolveMetadataRefreshEvents(
    events: DecodedMetadataRefreshEvent[],
    resolutionContext: CollectionResolutionContext,
): OnChainData["collectionScoped"]["metadataRefreshEvents"] {
    const resolved: OnChainData["collectionScoped"]["metadataRefreshEvents"] =
        [];

    for (const event of events) {
        const contract = event.contract.toLowerCase();
        const collectionId = resolveCollectionId(
            resolutionContext,
            contract,
            event.tokenId,
        );
        if (collectionId === null) {
            continue;
        }

        resolved.push({
            collectionId,
            ...event,
            contract,
        });
    }

    return resolved;
}

function resolveMetadataRefreshRangeEvents(
    events: DecodedMetadataRefreshRangeEvent[],
    resolutionContext: CollectionResolutionContext,
): OnChainData["collectionScoped"]["metadataRefreshRangeEvents"] {
    const resolved: OnChainData["collectionScoped"]["metadataRefreshRangeEvents"] =
        [];

    for (const event of events) {
        const contract = event.contract.toLowerCase();
        const ranges =
            resolutionContext.collectionScopeResolver.splitRangeByCollectionScope(
                resolutionContext.chainId,
                resolutionContext.collections,
                contract,
                event.fromTokenId,
                event.toTokenId,
            );

        for (const range of ranges) {
            resolved.push({
                collectionId: range.collectionId,
                contract,
                fromTokenId: range.fromTokenId,
                toTokenId: range.toTokenId,
                reason: event.reason,
                trigger: event.trigger,
                blockNumber: event.blockNumber,
                blockHash: event.blockHash,
                txHash: event.txHash,
                logIndex: event.logIndex,
            });
        }
    }

    return resolved;
}
