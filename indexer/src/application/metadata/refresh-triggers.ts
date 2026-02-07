import { decodeEventLog, encodeEventTopics } from "viem";
import { ERC4906_ABI } from "../../abi/index.js";
import type {
    MetadataRefreshEvent,
    MetadataRefreshRangeEvent,
} from "../../domain/onchain.js";
import type { Hex, RpcEvent, RpcLog } from "../../ports/rpc.js";

const [METADATA_UPDATE_TOPIC] = encodeEventTopics({
    abi: ERC4906_ABI,
    eventName: "MetadataUpdate",
}) as [Hex];
const [BATCH_METADATA_UPDATE_TOPIC] = encodeEventTopics({
    abi: ERC4906_ABI,
    eventName: "BatchMetadataUpdate",
}) as [Hex];

type MetadataRefreshLogDecode = {
    tokenEvents: MetadataRefreshEvent[];
    rangeEvents: MetadataRefreshRangeEvent[];
};

export const METADATA_REFRESH_EVENT_FILTERS =
    ERC4906_ABI as unknown as RpcEvent[];

// Decode a metadata refresh log into token-level or range-level refresh work.
// Batch events are represented as ranges so worker-side chunking can be applied.
export function decodeMetadataRefreshLog(
    log: RpcLog,
): MetadataRefreshLogDecode {
    const topic0 = log.topics[0];
    if (!topic0) return { tokenEvents: [], rangeEvents: [] };

    if (topic0 === METADATA_UPDATE_TOPIC) {
        const decoded = safeDecodeMetadataUpdate(log);
        if (!decoded) return { tokenEvents: [], rangeEvents: [] };
        return {
            tokenEvents: [
                {
                    contract: log.address,
                    tokenId: decoded.args.tokenId.toString(),
                    reason: "erc4906",
                    trigger: "erc4906.metadata-update",
                    blockNumber: log.blockNumber,
                    blockHash: log.blockHash,
                    txHash: log.transactionHash,
                    logIndex: log.logIndex,
                },
            ],
            rangeEvents: [],
        };
    }

    if (topic0 === BATCH_METADATA_UPDATE_TOPIC) {
        const decoded = safeDecodeBatchMetadataUpdate(log);
        if (!decoded) return { tokenEvents: [], rangeEvents: [] };
        const fromTokenId = decoded.args.fromTokenId;
        const toTokenId = decoded.args.toTokenId;
        if (fromTokenId > toTokenId) {
            return { tokenEvents: [], rangeEvents: [] };
        }
        return {
            tokenEvents: [],
            rangeEvents: [
                {
                    contract: log.address,
                    fromTokenId: fromTokenId.toString(),
                    toTokenId: toTokenId.toString(),
                    reason: "erc4906",
                    trigger: "erc4906.batch-metadata-update",
                    blockNumber: log.blockNumber,
                    blockHash: log.blockHash,
                    txHash: log.transactionHash,
                    logIndex: log.logIndex,
                },
            ],
        };
    }

    return { tokenEvents: [], rangeEvents: [] };
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
