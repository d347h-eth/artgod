import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { SqliteActivityDomain } from "../src/infra/domain/activities.js";

describe("activity domain sync", () => {
    loadTestEnv();

    beforeAll(async () => {
        const dbPath = await createTempDbPath();
        setDbPath(dbPath);
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
    });

    beforeEach(() => {
        db.exec(
            [
                "DELETE FROM activities;",
                "DELETE FROM fills;",
                "DELETE FROM nft_transfer_events;",
                "DELETE FROM collections;",
            ].join("\n"),
        );
    });

    it("persists activities with collection scope for transfers and fills", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const firstCollectionId = insertCollection(
            chainId,
            "alpha",
            contract,
            "1",
            10,
        );
        const secondCollectionId = insertCollection(
            chainId,
            "beta",
            contract,
            "11",
            10,
        );

        insertTransfer({
            chainId,
            collectionId: firstCollectionId,
            contract,
            tokenId: "1",
            from: "0x1000000000000000000000000000000000000000",
            to: "0x2000000000000000000000000000000000000000",
            amount: "1",
            blockNumber: 100,
            txHash: "0xtx-transfer",
            logIndex: 1,
        });
        insertFill({
            chainId,
            collectionId: secondCollectionId,
            contract,
            tokenId: "11",
            side: "sell",
            maker: "0x3000000000000000000000000000000000000000",
            taker: "0x4000000000000000000000000000000000000000",
            amount: "1",
            blockNumber: 101,
            txHash: "0xtx-fill",
            logIndex: 2,
        });

        const domain = new SqliteActivityDomain();
        await domain.handleDomainSync({
            chainId,
            fromBlock: 100,
            toBlock: 101,
            mode: "backfill",
            sourceJobId: "test-job",
            sourceKind: "test",
        });

        const rows = db
            .prepare<
                [number]
            >("SELECT collection_id, kind, contract_address, token_id, from_address, to_address " + "FROM activities WHERE chain_id = ? ORDER BY block_number ASC, log_index ASC")
            .all(chainId) as Array<{
            collection_id: number;
            kind: string;
            contract_address: string;
            token_id: string;
            from_address: string | null;
            to_address: string | null;
        }>;

        expect(rows).toEqual([
            {
                collection_id: firstCollectionId,
                kind: "transfer",
                contract_address: contract,
                token_id: "1",
                from_address: "0x1000000000000000000000000000000000000000",
                to_address: "0x2000000000000000000000000000000000000000",
            },
            {
                collection_id: secondCollectionId,
                kind: "fill",
                contract_address: contract,
                token_id: "11",
                from_address: "0x3000000000000000000000000000000000000000",
                to_address: "0x4000000000000000000000000000000000000000",
            },
        ]);
    });
});

function insertCollection(
    chainId: number,
    slug: string,
    address: string,
    scopeStartTokenId: string,
    scopeTotalSupply: number,
): number {
    const result = db
        .prepare<
            [number, string, string, string, number]
        >("INSERT INTO collections " + "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply) " + "VALUES (?, ?, ?, 'erc721', 'live', 'token_range', ?, ?)")
        .run(
            chainId,
            slug,
            address.toLowerCase(),
            scopeStartTokenId,
            scopeTotalSupply,
        );

    return Number(result.lastInsertRowid);
}

function insertTransfer(input: {
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    from: string;
    to: string;
    amount: string;
    blockNumber: number;
    txHash: string;
    logIndex: number;
}): void {
    db.prepare<
        [
            number,
            number,
            string,
            string,
            string,
            string,
            string,
            number,
            string,
            number,
            string,
            number,
        ]
    >(
        "INSERT INTO nft_transfer_events " +
            "(chain_id, collection_id, contract_address, from_address, to_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index, kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'transfer')",
    ).run(
        input.chainId,
        input.collectionId,
        input.contract.toLowerCase(),
        input.from.toLowerCase(),
        input.to.toLowerCase(),
        input.tokenId,
        input.amount,
        input.blockNumber,
        `0xblock-${input.blockNumber}`,
        1_700_000_000 + input.blockNumber,
        input.txHash,
        input.logIndex,
    );
}

function insertFill(input: {
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    side: string;
    maker: string;
    taker: string;
    amount: string;
    blockNumber: number;
    txHash: string;
    logIndex: number;
}): void {
    db.prepare<
        [
            number,
            number,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            number,
            string,
            number,
            string,
            number,
        ]
    >(
        "INSERT INTO fills " +
            "(chain_id, collection_id, kind, order_id, order_side, maker, taker, contract_address, token_id, amount, price, currency, block_number, block_hash, block_timestamp, tx_hash, log_index) " +
            "VALUES (?, ?, 'fill', ?, ?, ?, ?, ?, ?, ?, '100', '0x0000000000000000000000000000000000000000', ?, ?, ?, ?, ?)",
    ).run(
        input.chainId,
        input.collectionId,
        `order-${input.txHash}`,
        input.side,
        input.maker.toLowerCase(),
        input.taker.toLowerCase(),
        input.contract.toLowerCase(),
        input.tokenId,
        input.amount,
        input.blockNumber,
        `0xblock-${input.blockNumber}`,
        1_700_000_000 + input.blockNumber,
        input.txHash,
        input.logIndex,
    );
}
