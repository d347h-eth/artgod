import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { ERC4906_ABI } from "../src/abi/index.js";
import { decodeMetadataRefreshLog } from "../src/application/metadata/refresh-triggers.js";
import type { RpcLog } from "../src/ports/rpc.js";

const CONTRACT = "0x0000000000000000000000000000000000000abc" as Hex;
const BLOCK_HASH = `0x${"11".repeat(32)}` as Hex;
const TX_HASH = `0x${"22".repeat(32)}` as Hex;

function buildLog(data: Hex, topics: Hex[], logIndex = 2): RpcLog {
    return {
        address: CONTRACT,
        data,
        topics,
        blockNumber: 456,
        blockHash: BLOCK_HASH,
        transactionHash: TX_HASH,
        logIndex,
    };
}

function topic0(eventName: "MetadataUpdate" | "BatchMetadataUpdate"): Hex {
    const [signature] = encodeEventTopics({
        abi: ERC4906_ABI,
        eventName,
    }) as [Hex];
    return signature;
}

describe("metadata refresh decoders", () => {
    it("decodes MetadataUpdate into a single refresh event", () => {
        const data = encodeAbiParameters([{ type: "uint256" }], [123n]);
        const log = buildLog(data, [topic0("MetadataUpdate")]);
        const decoded = decodeMetadataRefreshLog(log);

        expect(decoded.rangeEvents).toHaveLength(0);
        expect(decoded.tokenEvents).toHaveLength(1);
        const event = decoded.tokenEvents[0];
        expect(event.contract).toBe(CONTRACT);
        expect(event.tokenId).toBe("123");
        expect(event.trigger).toBe("erc4906.metadata-update");
        expect(event.reason).toBe("erc4906");
        expect(event.blockNumber).toBe(456);
        expect(event.blockHash).toBe(BLOCK_HASH);
        expect(event.txHash).toBe(TX_HASH);
        expect(event.logIndex).toBe(2);
    });

    it("decodes BatchMetadataUpdate into a range refresh event", () => {
        const data = encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint256" }],
            [5n, 7n],
        );
        const log = buildLog(data, [topic0("BatchMetadataUpdate")], 9);
        const decoded = decodeMetadataRefreshLog(log);

        expect(decoded.tokenEvents).toHaveLength(0);
        expect(decoded.rangeEvents).toHaveLength(1);
        const event = decoded.rangeEvents[0];
        expect(event.contract).toBe(CONTRACT);
        expect(event.fromTokenId).toBe("5");
        expect(event.toTokenId).toBe("7");
        expect(event.trigger).toBe("erc4906.batch-metadata-update");
        expect(event.reason).toBe("erc4906");
        expect(event.logIndex).toBe(9);
    });
});
