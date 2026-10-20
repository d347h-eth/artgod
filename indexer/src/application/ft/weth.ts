import { decodeEventLog, encodeEventTopics, zeroAddress } from "viem";
import { GLOBAL_MAKER_TRIGGER_REASON } from "../../domain/maker-triggers.js";
import type { GlobalMakerTrigger } from "../../domain/onchain.js";
import type { Hex, RpcEvent, RpcLog } from "../../ports/rpc.js";

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

// Decode the acquired range without consulting a stale process-local bidder
// cache. The commit owner decides which retained orders an invalidation affects.
export function decodeWethMakerInfos(logs: RpcLog[]): GlobalMakerTrigger[] {
    const infos = new Map<string, GlobalMakerTrigger>();
    for (const log of logs) {
        const topic0 = log.topics[0];
        if (!topic0) continue;

        if (topic0 === TRANSFER_TOPIC) {
            const decoded = safeDecode(log, "Transfer");
            if (!decoded) continue;
            const args = decoded.args as { from: string; to: string };
            const from = args.from.toLowerCase();
            const to = args.to.toLowerCase();
            pushMakerInfo(
                infos,
                from,
                GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
                log,
            );
            pushMakerInfo(
                infos,
                to,
                GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
                log,
            );
            continue;
        }

        if (topic0 === APPROVAL_TOPIC) {
            const decoded = safeDecode(log, "Approval");
            if (!decoded) continue;
            const args = decoded.args as { owner: string };
            const owner = args.owner.toLowerCase();
            pushMakerInfo(
                infos,
                owner,
                GLOBAL_MAKER_TRIGGER_REASON.ApprovalChange,
                log,
            );
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
    infos: Map<string, GlobalMakerTrigger>,
    maker: string,
    reason: GlobalMakerTrigger["reason"],
    log: RpcLog,
) {
    if (!maker || maker === zeroAddress) return;
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
