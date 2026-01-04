import { decodeEventLog, encodeEventTopics, zeroAddress } from "viem";
import { ERC1155_ABI, ERC721_ABI } from "../abi/index.js";
import type { CollectionConfig } from "../config/index.js";
import type { OnChainData } from "../domain/onchain.js";
import type { Hex, RpcLog, RpcProviderPort } from "../ports/rpc.js";

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
const TRANSFER_EVENTS = [ERC721_ABI[0], ERC1155_ABI[0], ERC1155_ABI[1]] as const;

export async function syncRange(
    rpc: RpcProviderPort,
    collections: CollectionConfig[],
    range: SyncRange,
): Promise<OnChainData> {
    const addresses = collections.map((collection) => collection.address as Hex);
    if (addresses.length === 0) {
        return { nftTransferEvents: [], nftBalanceDeltas: [] };
    }

    // Query only transfer events for tracked collections within the range.
    const logs = await rpc.getLogs({
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        address: addresses.length === 1 ? addresses[0] : addresses,
        events: TRANSFER_EVENTS,
    });

    const data: OnChainData = {
        nftTransferEvents: [],
        nftBalanceDeltas: [],
    };

    for (const log of logs) {
        const events = decodeTransferLog(log);
        for (const event of events) {
            data.nftTransferEvents.push(event);
            pushBalanceDeltas(data, event);
        }
    }

    return data;
}

function decodeTransferLog(log: RpcLog): OnChainData["nftTransferEvents"] {
    const topic0 = log.topics[0];
    if (!topic0) return [];
    const topics = log.topics as [Hex, ...Hex[]];

    if (topic0 === ERC721_TRANSFER_TOPIC) {
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
                    contract: log.address,
                    from: from,
                    to: to,
                    tokenId: tokenId.toString(),
                    amount: "1",
                    blockNumber: log.blockNumber,
                    blockHash: log.blockHash,
                    txHash: log.transactionHash,
                    logIndex: log.logIndex,
                    kind: "erc721",
                },
            ];
        } catch {
            return [];
        }
    }

    if (topic0 === ERC1155_TRANSFER_SINGLE_TOPIC) {
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
                    contract: log.address,
                    from: from,
                    to: to,
                    tokenId: tokenId.toString(),
                    amount: value.toString(),
                    blockNumber: log.blockNumber,
                    blockHash: log.blockHash,
                    txHash: log.transactionHash,
                    logIndex: log.logIndex,
                    kind: "erc1155",
                },
            ];
        } catch {
            return [];
        }
    }

    if (topic0 === ERC1155_TRANSFER_BATCH_TOPIC) {
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
            const out: OnChainData["nftTransferEvents"] = [];
            for (let i = 0; i < ids.length; i += 1) {
                out.push({
                    contract: log.address,
                    from: from,
                    to: to,
                    tokenId: ids[i]?.toString() ?? "0",
                    amount: values[i]?.toString() ?? "0",
                    blockNumber: log.blockNumber,
                    blockHash: log.blockHash,
                    txHash: log.transactionHash,
                    logIndex: log.logIndex,
                    kind: "erc1155",
                });
            }
            return out;
        } catch {
            return [];
        }
    }

    return [];
}

function pushBalanceDeltas(data: OnChainData, event: OnChainData["nftTransferEvents"][number]) {
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
