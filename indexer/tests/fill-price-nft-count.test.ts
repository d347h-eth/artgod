import { beforeAll, expect, it } from "vitest";
import {
    decodeAbiParameters,
    encodeAbiParameters,
    parseAbiParameters,
} from "viem";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { FILL_KIND } from "@artgod/shared/market-data/fills";
import { decodeSeaportFills } from "../src/application/fills/seaport.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import type { OnChainData } from "../src/domain/onchain.js";
import type { RpcBlock } from "../src/ports/rpc.js";
import { readTxDump, toEnhancedTransaction } from "./helpers/tx-dumps.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";

const BUNDLE_FIXTURE =
    "0xf2581f8779cb451f662ea3bbc5f6051121c68e3ed653270505cee26315a4e478.json";
const CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
// Deliberately assert the protocol's event serialization at the wire boundary.
const EVENT_DATA = parseAbiParameters(
    "bytes32 orderHash, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration",
);

it("counts untracked bundle NFTs before collection attribution", async () => {
    const tx = toEnhancedTransaction(
        await readTxDump(import.meta.url, "fill-txs", BUNDLE_FIXTURE),
    );
    const original = decodeSeaportFills(tx, new Set([CONTRACT]));
    expect(original).toHaveLength(2);
    expect(original.map((fill) => fill.priceNftCount)).toEqual(["2", "2"]);
    const log = tx.receiptLogs.find(
        (candidate) => candidate.logIndex === original[0]!.logIndex,
    )!;
    const [hash, recipient, offer, consideration] = decodeAbiParameters(
        EVENT_DATA,
        log.data,
    );
    const changedOffer = offer.map((item, i) =>
        i === 1
            ? {
                  ...item,
                  token: "0x1111111111111111111111111111111111111111" as const,
              }
            : item,
    );
    log.data = encodeAbiParameters(EVENT_DATA, [
        hash,
        recipient,
        changedOffer,
        consideration,
    ]);
    const fills = decodeSeaportFills(tx, new Set([CONTRACT]));
    expect(fills).toHaveLength(1);
    expect(fills[0]!.priceNftCount).toBe("2");
});

it("keeps independent single-token orders in a batched transaction eligible", async () => {
    const tx = toEnhancedTransaction(
        await readTxDump(
            import.meta.url,
            "fill-txs",
            "0x10639cf281b96d54a1bb4fe9b34647e77cac1e05468642e08978cbf6f06d198d.json",
        ),
    );
    const fills = decodeSeaportFills(tx, new Set([CONTRACT]));
    expect(fills).toHaveLength(5);
    expect(fills.every((fill) => fill.priceNftCount === "1")).toBe(true);
});

beforeAll(async () => {
    const root = resolveProjectPath("tmp/fill-price-nft-count");
    mkdirSync(root, { recursive: true });
    setDbPath(join(mkdtempSync(join(root, "run-")), "fixture.sqlite"));
    await createMigrationRunner().runMigrations();
});

it("enriches a replayed legacy fill without duplication, and rolls it back on reorg", () => {
    const storage = new SqliteStorage();
    const data: OnChainData = {
        transactions: [],
        global: { cancelEvents: [], makerTriggers: [] },
        collectionScoped: {
            nftTransferEvents: [],
            nftApprovalEvents: [],
            nftBalanceDeltas: [],
            orderInfos: [],
            makerTriggers: [],
            metadataRefreshEvents: [],
            metadataRefreshRangeEvents: [],
            collectionExtensionEvents: [],
            collectionExtensionEventMedia: [],
            fillEvents: [
                {
                    collectionId: 1,
                    kind: FILL_KIND.Seaport,
                    contract: CONTRACT,
                    tokenId: "1",
                    amount: "1",
                    price: "42",
                    currency: "0x0000000000000000000000000000000000000000",
                    blockNumber: 1,
                    blockHash: "0x01",
                    txHash: "0x02",
                    logIndex: 1,
                },
            ],
        },
    };
    const blocks: RpcBlock[] = [
        {
            number: 1,
            hash: "0x01",
            parentHash: "0x00",
            timestamp: 100,
            transactions: [],
        },
    ];
    storage.persistSyncResult({
        checkpoint: storage.captureSyncCheckpoint(1),
        blocks,
        data,
        collections: [],
    });
    expect(db.prepare("SELECT price_nft_count FROM fills").get()).toEqual({
        price_nft_count: null,
    });
    data.collectionScoped.fillEvents[0]!.priceNftCount = "2";
    storage.persistSyncResult({
        checkpoint: storage.captureSyncCheckpoint(1),
        blocks,
        data,
        collections: [],
    });
    delete data.collectionScoped.fillEvents[0]!.priceNftCount;
    storage.persistSyncResult({
        checkpoint: storage.captureSyncCheckpoint(1),
        blocks,
        data,
        collections: [],
    });
    expect(db.prepare("SELECT price_nft_count FROM fills").all()).toEqual([
        { price_nft_count: "2" },
    ]);
    commitRollbackFixture({
        storage,
        chainId: 1,
        fromBlock: 1,
        owners: [],
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM fills").get()).toEqual({
        n: 0,
    });
});
