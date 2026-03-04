import { decodeEventLog, encodeEventTopics, zeroAddress } from "viem";
import type { MakerInfo } from "../../domain/onchain.js";
import type { Hex, RpcEvent, RpcLog } from "../../ports/rpc.js";
import type { BidderIndex } from "../bidder-index.js";

const ERC20_EVENT_ABI = [
    {
        type: "event",
        name: "Transfer",
        inputs: [
            { indexed: true, name: "from", type: "address" },
            { indexed: true, name: "to", type: "address" },
            { indexed: false, name: "value", type: "uint256" },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Approval",
        inputs: [
            { indexed: true, name: "owner", type: "address" },
            { indexed: true, name: "spender", type: "address" },
            { indexed: false, name: "value", type: "uint256" },
        ],
        anonymous: false,
    },
] as const;

const [TRANSFER_TOPIC] = encodeEventTopics({
    abi: ERC20_EVENT_ABI,
    eventName: "Transfer",
}) as [Hex];

const [APPROVAL_TOPIC] = encodeEventTopics({
    abi: ERC20_EVENT_ABI,
    eventName: "Approval",
}) as [Hex];

export const WETH_EVENT_FILTERS = ERC20_EVENT_ABI as unknown as RpcEvent[];

// Decode WETH transfer/approval logs into maker triggers (ephemeral).
export function decodeWethMakerInfos(
    logs: RpcLog[],
    bidderIndex: BidderIndex,
): MakerInfo[] {
    const infos = new Map<string, MakerInfo>();
    for (const log of logs) {
        const topic0 = log.topics[0];
        if (!topic0) continue;

        if (topic0 === TRANSFER_TOPIC) {
            const decoded = safeDecode(log, "Transfer");
            if (!decoded) continue;
            const args = decoded.args as { from: string; to: string };
            const from = args.from.toLowerCase();
            const to = args.to.toLowerCase();
            pushMakerInfo(infos, bidderIndex, from, "erc20-balance", log);
            pushMakerInfo(infos, bidderIndex, to, "erc20-balance", log);
            continue;
        }

        if (topic0 === APPROVAL_TOPIC) {
            const decoded = safeDecode(log, "Approval");
            if (!decoded) continue;
            const args = decoded.args as { owner: string };
            const owner = args.owner.toLowerCase();
            pushMakerInfo(infos, bidderIndex, owner, "approval-change", log);
        }
    }
    return Array.from(infos.values());
}

function safeDecode(log: RpcLog, eventName: "Transfer" | "Approval") {
    try {
        return decodeEventLog({
            abi: ERC20_EVENT_ABI,
            eventName,
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
        });
    } catch {
        return null;
    }
}

function pushMakerInfo(
    infos: Map<string, MakerInfo>,
    bidderIndex: BidderIndex,
    maker: string,
    reason: MakerInfo["reason"],
    log: RpcLog,
) {
    if (!maker || maker === zeroAddress) return;
    if (!bidderIndex.shouldEmit(maker)) return;
    if (infos.has(maker)) return;
    infos.set(maker, {
        maker,
        reason,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
    });
}
