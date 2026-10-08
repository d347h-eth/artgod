import { decodeEventLog, encodeEventTopics } from "viem";
import {
    ERC1155_ABI,
    ERC1155_EVENT_NAME,
    ERC721_ABI,
    ERC721_EVENT_NAME,
} from "../abi/index.js";
import { COLLECTION_STANDARD } from "../domain/collections.js";
import type { EnhancedEvent } from "../domain/onchain.js";
import type { Hex, RpcLog } from "../ports/rpc.js";

export const NFT_TRANSFER_EVENTS = [
    ERC721_ABI[0],
    ERC1155_ABI[0],
    ERC1155_ABI[1],
] as const;
const [ERC721_TRANSFER_TOPIC] = encodeEventTopics({
    abi: ERC721_ABI,
    eventName: ERC721_EVENT_NAME.Transfer,
}) as [Hex];
const [ERC1155_TRANSFER_SINGLE_TOPIC] = encodeEventTopics({
    abi: ERC1155_ABI,
    eventName: ERC1155_EVENT_NAME.TransferSingle,
}) as [Hex];
const [ERC1155_TRANSFER_BATCH_TOPIC] = encodeEventTopics({
    abi: ERC1155_ABI,
    eventName: ERC1155_EVENT_NAME.TransferBatch,
}) as [Hex];

/**
 * Route a log to the correct transfer decoder based on topic0.
 * TransferBatch expands into multiple EnhancedEvent entries.
 */
export function decodeNftTransferLog(log: RpcLog): EnhancedEvent[] {
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
            eventName: ERC721_EVENT_NAME.Transfer,
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
                    standard: COLLECTION_STANDARD.Erc721,
                    from: from,
                    to: to,
                    tokenId: tokenId.toString(),
                    amount: "1",
                },
                kind: COLLECTION_STANDARD.Erc721,
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
            eventName: ERC1155_EVENT_NAME.TransferSingle,
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
                    standard: COLLECTION_STANDARD.Erc1155,
                    from: from,
                    to: to,
                    tokenId: tokenId.toString(),
                    amount: value.toString(),
                },
                kind: COLLECTION_STANDARD.Erc1155,
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
            eventName: ERC1155_EVENT_NAME.TransferBatch,
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
                    standard: COLLECTION_STANDARD.Erc1155,
                    from: from,
                    to: to,
                    tokenId: ids[i]?.toString() ?? "0",
                    amount: values[i]?.toString() ?? "0",
                },
                kind: COLLECTION_STANDARD.Erc1155,
            });
        }
        return out;
    } catch {
        return [];
    }
}
