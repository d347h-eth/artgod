import { decodeEventLog, encodeEventTopics } from "viem";
import { ERC4906_ABI } from "../../abi/index.js";
import type { MetadataRefreshEvent } from "../../domain/onchain.js";
import type { Hex, RpcEvent, RpcLog } from "../../ports/rpc.js";

const [METADATA_UPDATE_TOPIC] = encodeEventTopics({
    abi: ERC4906_ABI,
    eventName: "MetadataUpdate",
}) as [Hex];
const [BATCH_METADATA_UPDATE_TOPIC] = encodeEventTopics({
    abi: ERC4906_ABI,
    eventName: "BatchMetadataUpdate",
}) as [Hex];

// Safety cap for batch refresh: prevents huge fan-out from a single log.
// Later we can replace this with chunked jobs or a range-aware refresh worker.
const MAX_METADATA_BATCH_SIZE = 200;

type MetadataRefreshTrigger = {
    key: string;
    reason: string;
    topic0: Hex;
    eventName: "MetadataUpdate" | "BatchMetadataUpdate";
    decodeTokenIds: (log: RpcLog) => string[];
};

// Registry of on-chain metadata refresh triggers.
// Add new trigger definitions here when we support collection-specific events.
const METADATA_REFRESH_TRIGGERS: MetadataRefreshTrigger[] = [
    {
        key: "erc4906.metadata-update",
        reason: "erc4906",
        topic0: METADATA_UPDATE_TOPIC,
        eventName: "MetadataUpdate",
        decodeTokenIds: (log) => {
            const decoded = safeDecodeMetadataUpdate(log);
            if (!decoded) return [];
            const tokenId = decoded.args.tokenId;
            return [tokenId.toString()];
        },
    },
    {
        key: "erc4906.batch-metadata-update",
        reason: "erc4906",
        topic0: BATCH_METADATA_UPDATE_TOPIC,
        eventName: "BatchMetadataUpdate",
        decodeTokenIds: (log) => {
            const decoded = safeDecodeBatchMetadataUpdate(log);
            if (!decoded) return [];
            const fromTokenId = decoded.args.fromTokenId;
            const toTokenId = decoded.args.toTokenId;
            if (fromTokenId > toTokenId) return [];
            const span = Number(toTokenId - fromTokenId + 1n);
            if (!Number.isFinite(span) || span > MAX_METADATA_BATCH_SIZE) {
                return [];
            }
            const ids: string[] = [];
            for (
                let tokenId = fromTokenId;
                tokenId <= toTokenId;
                tokenId += 1n
            ) {
                ids.push(tokenId.toString());
            }
            return ids;
        },
    },
];

export const METADATA_REFRESH_EVENT_FILTERS =
    ERC4906_ABI as unknown as RpcEvent[];

// Decode a log into zero or more metadata refresh events.
export function decodeMetadataRefreshLog(
    log: RpcLog,
): MetadataRefreshEvent[] {
    const topic0 = log.topics[0];
    if (!topic0) return [];

    const trigger = METADATA_REFRESH_TRIGGERS.find(
        (candidate) => candidate.topic0 === topic0,
    );
    if (!trigger) return [];

    const tokenIds = trigger.decodeTokenIds(log);
    if (tokenIds.length === 0) return [];

    return tokenIds.map((tokenId) => ({
        contract: log.address,
        tokenId,
        reason: trigger.reason,
        trigger: trigger.key,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
    }));
}

function safeDecodeMetadataUpdate(log: RpcLog) {
    try {
        return decodeEventLog({
            abi: ERC4906_ABI,
            eventName: "MetadataUpdate",
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
        });
    } catch {
        return null;
    }
}

function safeDecodeBatchMetadataUpdate(log: RpcLog) {
    try {
        return decodeEventLog({
            abi: ERC4906_ABI,
            eventName: "BatchMetadataUpdate",
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
        });
    } catch {
        return null;
    }
}
