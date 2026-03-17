import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { decodeSeaportOrderEvents } from "../src/application/fills/seaport-events.js";
import { GLOBAL_MAKER_TRIGGER_REASON } from "../src/domain/maker-triggers.js";
import type { Hex, RpcLog } from "../src/ports/rpc.js";
import { resolveFixturePath } from "./helpers/fixture-paths.js";

type TxDump = {
    receipt?: {
        logs?: Array<{
            address: string;
            data: string;
            topics: string[];
            blockNumber: string | number;
            blockHash: string;
            transactionHash: string;
            logIndex: number;
        }>;
    };
};

const CASES = [
    {
        name: "OrderCancelled",
        dumpFile:
            "0x79473e1015cf9131735dd3edc422b22b7884a2f372eaac7cd72af6e163459cac.json",
        expectCancel: true,
        expectCounter: false,
        expectedMaker: "0xa8df7cfc1fa79979f0e84dc7d4679b277ba84127",
        expectedOrderId:
            "0xe778622cb97d7f8af1c0becac23041d5f7f99861b16ea5b04fa794d844a31fb1",
    },
    {
        name: "CounterIncremented",
        dumpFile:
            "0xb439334318e0675f7af61797eabc7753654e255f8be54773aa80172ad80ef362.json",
        expectCancel: false,
        expectCounter: true,
        expectedMaker: "0xa8df7cfc1fa79979f0e84dc7d4679b277ba84127",
    },
];

describe("seaport order lifecycle events", () => {
    it.each(CASES)(
        "$name",
        async ({
            dumpFile,
            expectCancel,
            expectCounter,
            expectedMaker,
            expectedOrderId,
        }) => {
            const dump = await readTxDump(dumpFile);
            const logs = toRpcLogs(dump);
            const collections = new Set<string>();
            const result = decodeSeaportOrderEvents(logs, collections);

            expect(result.cancels.length > 0).toBe(expectCancel);
            expect(result.globalMakerTriggers.length > 0).toBe(expectCounter);
            if (expectCancel && expectedOrderId) {
                const cancel = result.cancels[0];
                expect(cancel?.orderId).toBe(expectedOrderId);
                expect(cancel?.maker).toBe(expectedMaker);
            }
            if (expectCounter) {
                const maker = result.globalMakerTriggers[0];
                expect(maker?.maker).toBe(expectedMaker);
                expect(maker?.reason).toBe(
                    GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
                );
            }
        },
    );
});

async function readTxDump(file: string): Promise<TxDump> {
    const resolved = resolveFixturePath(import.meta.url, "tx", file);
    const raw = await fs.readFile(resolved, "utf8");
    return JSON.parse(raw) as TxDump;
}

function toRpcLogs(dump: TxDump): RpcLog[] {
    const logs = dump.receipt?.logs ?? [];
    return logs.map((log) => ({
        address: log.address as Hex,
        data: log.data as Hex,
        topics: log.topics as Hex[],
        blockNumber: Number(log.blockNumber),
        blockHash: log.blockHash as Hex,
        transactionHash: log.transactionHash as Hex,
        logIndex: log.logIndex,
    }));
}
