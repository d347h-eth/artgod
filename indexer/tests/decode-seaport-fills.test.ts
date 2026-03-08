import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { zeroAddress } from "viem";
import { decodeSeaportFill } from "../src/application/fills/seaport.js";
import {
    decodeErc1155TransferBatch,
    decodeErc1155TransferSingle,
    decodeErc721Transfer,
} from "../src/application/sync.js";
import type { EnhancedTransaction } from "../src/domain/onchain.js";
import type { RpcLog } from "../src/ports/rpc.js";
import type { Hex } from "../src/ports/rpc.js";
import { resolveFixturePath } from "./helpers/fixture-paths.js";

type TxDump = {
    tx: {
        hash: string;
        from: string;
        to: string | null;
        input: Hex;
        blockNumber: string | number;
        blockHash: string;
    };
    receipt?: {
        logs?: Array<{
            address: Hex;
            data: Hex;
            topics: Hex[];
            blockNumber: string | number;
            blockHash: Hex;
            transactionHash: Hex;
            logIndex: number;
        }>;
    };
};

const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

const CASES = [
    {
        name: "seaport take bid (fulfillAdvancedOrder)",
        dumpFile:
            "0xff81723998672fc56590b551ce13ac409cb3f365219e2aef20fcf194652b7d00.json",
        expected: {
            orderSide: "buy",
            maker: "0x8790aa2c89aece345bd8fe757bf8a675ea31af3c",
            taker: "0x193dc59c444398276b0864423f5056d87b7dcaf8",
            contract: "0x4e1f41613c9084fdb9e34e11fae9412427480e56",
            tokenId: "8011",
            priceTotal: "0.23",
            currency: WETH_ADDRESS,
        },
    },
    {
        name: "seaport take ask (fulfillBasicOrder_efficient_6GL6yc)",
        dumpFile:
            "0x30e4c9eabe1a74cb71ea2d9f4405318d277f0d0e5590f31d450704c5c98803cd.json",
        expected: {
            orderSide: "sell",
            maker: "0x3f51e7af7cf3e4be9af7b8f58324d0b085f4e4d9",
            taker: "0xd57721b29f2a17ab6a0635210ce05dbbecf5cbf4",
            contract: "0x4e1f41613c9084fdb9e34e11fae9412427480e56",
            tokenId: "7058",
            priceTotal: "0.25",
            currency: zeroAddress,
        },
    },
];

describe("seaport fill decoding (no traces)", () => {
    it.each(CASES)("$name", async ({ dumpFile, expected }) => {
        const dump = await readTxDump(dumpFile);
        const tx = toEnhancedTransaction(dump);
        const collections = new Set([expected.contract]);

        const fill = decodeSeaportFill(tx, collections);
        expect(fill).not.toBeNull();
        if (!fill) return;

        expect(fill.orderSide).toBe(expected.orderSide);
        expect(fill.maker).toBe(expected.maker);
        expect(fill.taker).toBe(expected.taker);
        expect(fill.contract).toBe(expected.contract);
        expect(fill.tokenId).toBe(expected.tokenId);
        expect(fill.currency).toBe(expected.currency);
        expect(fill.price).toBe(parseEther(expected.priceTotal).toString());
    });
});

async function readTxDump(file: string): Promise<TxDump> {
    const resolved = resolveFixturePath(import.meta.url, "tx", file);
    const raw = await fs.readFile(resolved, "utf8");
    return JSON.parse(raw) as TxDump;
}

function toEnhancedTransaction(dump: TxDump): EnhancedTransaction {
    const receiptLogs = toReceiptLogs(dump);
    return {
        txHash: dump.tx.hash,
        transaction: {
            hash: dump.tx.hash,
            from: dump.tx.from,
            to: dump.tx.to,
            input: dump.tx.input,
        },
        events: extractTransferEvents(dump),
        receiptLogs,
        blockNumber: Number(dump.tx.blockNumber),
        blockHash: dump.tx.blockHash,
    };
}

function extractTransferEvents(dump: TxDump) {
    const logs = dump.receipt?.logs ?? [];
    const events = [];
    for (const log of logs) {
        const rpcLog: RpcLog = {
            address: log.address,
            data: log.data,
            topics: log.topics,
            blockNumber: Number(log.blockNumber),
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
        };
        events.push(
            ...decodeErc721Transfer(rpcLog),
            ...decodeErc1155TransferSingle(rpcLog),
            ...decodeErc1155TransferBatch(rpcLog),
        );
    }
    return events;
}

function toReceiptLogs(dump: TxDump): RpcLog[] {
    const logs = dump.receipt?.logs ?? [];
    return logs.map((log) => ({
        address: log.address,
        data: log.data,
        topics: log.topics,
        blockNumber: Number(log.blockNumber),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
    }));
}

function parseEther(value: string): bigint {
    const [whole, fraction = ""] = value.split(".");
    const normalized = `${fraction}000000000000000000`.slice(0, 18);
    const wholePart = whole === "" ? 0n : BigInt(whole);
    const fractionPart = normalized === "" ? 0n : BigInt(normalized);
    return wholePart * 10n ** 18n + fractionPart;
}
