import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { ERC1155_ABI, ERC721_ABI } from "../src/abi/index.js";
import {
    decodeErc1155ApprovalForAll,
    decodeErc1155TransferBatch,
    decodeErc1155TransferSingle,
    decodeErc721Approval,
    decodeErc721ApprovalForAll,
    decodeErc721Transfer,
} from "../src/application/sync.js";
import type { RpcLog } from "../src/ports/rpc.js";

const CONTRACT = "0x0000000000000000000000000000000000000abc" as Hex;
const FROM = "0x00000000000000000000000000000000000000a1" as Hex;
const TO = "0x00000000000000000000000000000000000000b2" as Hex;
const OPERATOR = "0x00000000000000000000000000000000000000c3" as Hex;
const BLOCK_HASH = `0x${"11".repeat(32)}` as Hex;
const TX_HASH = `0x${"22".repeat(32)}` as Hex;

function buildLog(data: Hex, topics: Hex[], logIndex = 7): RpcLog {
    return {
        address: CONTRACT,
        data,
        topics,
        blockNumber: 123,
        blockHash: BLOCK_HASH,
        transactionHash: TX_HASH,
        logIndex,
    };
}

function eventTopics(
    abi: readonly unknown[],
    eventName: string,
    indexed: Array<{ type: string; value: unknown }>,
): Hex[] {
    const [topic0] = encodeEventTopics({
        abi,
        eventName,
    }) as [Hex];
    const topics: Hex[] = [topic0];
    for (const arg of indexed) {
        topics.push(
            encodeAbiParameters([{ type: arg.type }], [arg.value]) as Hex,
        );
    }
    return topics;
}

describe("transfer decoders", () => {
    it("decodes ERC721 Transfer", () => {
        const topics = eventTopics(ERC721_ABI, "Transfer", [
            { type: "address", value: FROM },
            { type: "address", value: TO },
            { type: "uint256", value: 1n },
        ]);
        const log = buildLog("0x", topics);
        const events = decodeErc721Transfer(log);

        expect(events).toHaveLength(1);
        const event = events[0];
        expect(event.kind).toBe("erc721");
        expect(event.base.contract).toBe(CONTRACT);
        expect(event.base.blockNumber).toBe(123);
        expect(event.base.blockHash).toBe(BLOCK_HASH);
        expect(event.base.txHash).toBe(TX_HASH);
        expect(event.base.logIndex).toBe(7);
        expect(event.decoded.standard).toBe("erc721");
        expect(event.decoded.from.toLowerCase()).toBe(FROM);
        expect(event.decoded.to.toLowerCase()).toBe(TO);
        expect(event.decoded.tokenId).toBe("1");
        expect(event.decoded.amount).toBe("1");
    });

    it("decodes ERC721 Approval", () => {
        const topics = eventTopics(ERC721_ABI, "Approval", [
            { type: "address", value: FROM },
            { type: "address", value: OPERATOR },
            { type: "uint256", value: 123n },
        ]);
        const log = buildLog("0x", topics, 11);
        const events = decodeErc721Approval(log);

        expect(events).toHaveLength(1);
        const event = events[0];
        expect(event).toMatchObject({
            scope: "token",
            contract: CONTRACT,
            tokenId: "123",
            kind: "erc721",
            logIndex: 11,
        });
        expect(event?.owner.toLowerCase()).toBe(FROM);
        expect(event?.operator.toLowerCase()).toBe(OPERATOR);
    });

    it("decodes ERC721 ApprovalForAll", () => {
        const topics = eventTopics(ERC721_ABI, "ApprovalForAll", [
            { type: "address", value: FROM },
            { type: "address", value: OPERATOR },
        ]);
        const data = encodeAbiParameters([{ type: "bool" }], [true]);
        const log = buildLog(data, topics, 12);
        const events = decodeErc721ApprovalForAll(log);

        expect(events).toHaveLength(1);
        const event = events[0];
        expect(event).toMatchObject({
            scope: "collection",
            contract: CONTRACT,
            approved: true,
            kind: "erc721",
            logIndex: 12,
        });
        expect(event?.owner.toLowerCase()).toBe(FROM);
        expect(event?.operator.toLowerCase()).toBe(OPERATOR);
    });

    it("decodes ERC1155 TransferSingle", () => {
        const topics = eventTopics(ERC1155_ABI, "TransferSingle", [
            { type: "address", value: OPERATOR },
            { type: "address", value: FROM },
            { type: "address", value: TO },
        ]);
        const data = encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint256" }],
            [42n, 5n],
        );
        const log = buildLog(data, topics, 9);
        const events = decodeErc1155TransferSingle(log);

        expect(events).toHaveLength(1);
        const event = events[0];
        expect(event.kind).toBe("erc1155");
        expect(event.base.logIndex).toBe(9);
        expect(event.base.batchIndex).toBe(0);
        expect(event.decoded.standard).toBe("erc1155");
        expect(event.decoded.tokenId).toBe("42");
        expect(event.decoded.amount).toBe("5");
    });

    it("decodes ERC1155 TransferBatch", () => {
        const topics = eventTopics(ERC1155_ABI, "TransferBatch", [
            { type: "address", value: OPERATOR },
            { type: "address", value: FROM },
            { type: "address", value: TO },
        ]);
        const data = encodeAbiParameters(
            [{ type: "uint256[]" }, { type: "uint256[]" }],
            [
                [7n, 8n],
                [11n, 12n],
            ],
        );
        const log = buildLog(data, topics, 3);
        const events = decodeErc1155TransferBatch(log);

        expect(events).toHaveLength(2);
        expect(events[0]?.base.batchIndex).toBe(0);
        expect(events[0]?.decoded.tokenId).toBe("7");
        expect(events[0]?.decoded.amount).toBe("11");
        expect(events[1]?.base.batchIndex).toBe(1);
        expect(events[1]?.decoded.tokenId).toBe("8");
        expect(events[1]?.decoded.amount).toBe("12");
    });

    it("decodes ERC1155 ApprovalForAll", () => {
        const topics = eventTopics(ERC1155_ABI, "ApprovalForAll", [
            { type: "address", value: FROM },
            { type: "address", value: OPERATOR },
        ]);
        const data = encodeAbiParameters([{ type: "bool" }], [false]);
        const log = buildLog(data, topics, 13);
        const events = decodeErc1155ApprovalForAll(log);

        expect(events).toHaveLength(1);
        const event = events[0];
        expect(event).toMatchObject({
            scope: "collection",
            contract: CONTRACT,
            approved: false,
            kind: "erc1155",
            logIndex: 13,
        });
        expect(event?.owner.toLowerCase()).toBe(FROM);
        expect(event?.operator.toLowerCase()).toBe(OPERATOR);
    });
});
