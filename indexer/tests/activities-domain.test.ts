import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { DOMAIN_SYNC_PROJECTION } from "../src/domain/domain-jobs.js";
import { SqliteActivityDomain } from "../src/infra/domain/activities.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("activity domain", () => {
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
                "DELETE FROM activity_sources;",
                "DELETE FROM activities;",
                "DELETE FROM collection_extension_events;",
                "DELETE FROM fills;",
                "DELETE FROM nft_transfer_events;",
                "DELETE FROM collections;",
            ].join("\n"),
        );
    });

    it("projects collection extension event facts into custom activity rows", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const collectionId = insertCollection(chainId, "alpha", contract);
        const contentHash = `0x${"ab".repeat(32)}`;
        insertCollectionExtensionEvent({
            chainId,
            collectionId,
            extensionKey: "example-extension",
            eventKey: "custom-event",
            contract,
            tokenId: "1",
            maker: "0x3000000000000000000000000000000000000000",
            contentHash,
            blockNumber: 110,
            blockTimestamp: 1_700_000_110,
            txHash: "0xtx-extension",
            logIndex: 9,
            payload: {
                eventKey: "custom-event",
                contentHash,
                value: "example",
            },
        });

        const domain = new SqliteActivityDomain();
        await domain.handleDomainSync({
            chainId,
            collectionId: null,
            fromBlock: 110,
            toBlock: 110,
            mode: "backfill",
            projection: DOMAIN_SYNC_PROJECTION.FactsOnly,
            sourceJobId: "test-job",
            sourceKind: "test",
        });

        const row = db
            .prepare<{
                chainId: number;
            }>(
                "SELECT kind, source_kind, source_name, token_id, maker, payload_json, dedupe_key " +
                    "FROM activities WHERE chain_id = @chainId LIMIT 1",
            )
            .get({ chainId }) as {
            kind: string;
            source_kind: string;
            source_name: string;
            token_id: string | null;
            maker: string | null;
            payload_json: string | null;
            dedupe_key: string;
        };

        expect(row).toEqual({
            kind: "custom",
            source_kind: "extension",
            source_name: "example-extension",
            token_id: "1",
            maker: "0x3000000000000000000000000000000000000000",
            payload_json: JSON.stringify({
                eventKey: "custom-event",
                contentHash,
                value: "example",
                extensionKey: "example-extension",
            }),
            dedupe_key:
                "extension:example-extension:custom-event:1:0xtx-extension:9:1",
        });
    });

    it("projects tokenless collection extension facts into collection-scoped activity rows", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const collectionId = insertCollection(chainId, "alpha", contract);
        insertCollectionExtensionEvent({
            chainId,
            collectionId,
            extensionKey: "example-extension",
            eventKey: "system-event",
            contract,
            tokenId: "",
            maker: "0x3000000000000000000000000000000000000000",
            contentHash: null,
            blockNumber: 111,
            blockTimestamp: 1_700_000_111,
            txHash: "0xtx-extension-system",
            logIndex: 10,
            payload: {
                eventKey: "system-event",
                eventGroup: "system",
                value: "example",
            },
        });

        const domain = new SqliteActivityDomain();
        await domain.handleDomainSync({
            chainId,
            collectionId: null,
            fromBlock: 111,
            toBlock: 111,
            mode: "backfill",
            projection: DOMAIN_SYNC_PROJECTION.FactsOnly,
            sourceJobId: "test-job",
            sourceKind: "test",
        });

        const row = db
            .prepare<{ chainId: number }>(
                "SELECT scope_kind, token_id, maker, payload_json FROM activities WHERE chain_id = @chainId LIMIT 1",
            )
            .get({ chainId }) as {
            scope_kind: string;
            token_id: string | null;
            maker: string | null;
            payload_json: string | null;
        };

        expect(row).toEqual({
            scope_kind: "collection",
            token_id: null,
            maker: "0x3000000000000000000000000000000000000000",
            payload_json: JSON.stringify({
                eventKey: "system-event",
                eventGroup: "system",
                value: "example",
                extensionKey: "example-extension",
                contentHash: null,
            }),
        });
    });

    it("projects transfer and sale feed rows from onchain source tables", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const collectionId = insertCollection(chainId, "alpha", contract);

        insertTransfer({
            chainId,
            collectionId,
            contract,
            tokenId: "1",
            from: "0x1000000000000000000000000000000000000000",
            to: "0x2000000000000000000000000000000000000000",
            amount: "1",
            blockNumber: 100,
            blockTimestamp: 1_700_000_100,
            txHash: "0xtx-transfer",
            logIndex: 1,
            standard: "erc721",
        });
        insertFill({
            chainId,
            collectionId,
            contract,
            tokenId: "1",
            orderId: "order-2",
            side: "sell",
            maker: "0x3000000000000000000000000000000000000000",
            taker: "0x4000000000000000000000000000000000000000",
            amount: "1",
            price: "1000000000000000000",
            currency: ZERO_ADDRESS,
            blockNumber: 101,
            blockTimestamp: 1_700_000_101,
            txHash: "0xtx-sale",
            logIndex: 2,
            kind: "seaport",
        });

        const domain = new SqliteActivityDomain();
        await domain.handleDomainSync({
            chainId,
            collectionId: null,
            fromBlock: 100,
            toBlock: 101,
            mode: "backfill",
            projection: DOMAIN_SYNC_PROJECTION.FactsOnly,
            sourceJobId: "test-job",
            sourceKind: "test",
        });

        const rows = db
            .prepare<
                [number]
            >("SELECT kind, occurred_at, source_kind, source_name, price, currency, from_address, to_address, payload_json " + "FROM activities WHERE chain_id = ? ORDER BY occurred_at ASC, id ASC")
            .all(chainId) as Array<{
            kind: string;
            occurred_at: number;
            source_kind: string;
            source_name: string;
            price: string | null;
            currency: string | null;
            from_address: string | null;
            to_address: string | null;
            payload_json: string | null;
        }>;

        expect(rows).toEqual([
            {
                kind: "transfer",
                occurred_at: 1_700_000_100,
                source_kind: "onchain",
                source_name: "onchain",
                price: null,
                currency: null,
                from_address: "0x1000000000000000000000000000000000000000",
                to_address: "0x2000000000000000000000000000000000000000",
                payload_json: JSON.stringify({ standard: "erc721" }),
            },
            {
                kind: "sale",
                occurred_at: 1_700_000_101,
                source_kind: "onchain",
                source_name: "seaport",
                price: "1000000000000000000",
                currency: ZERO_ADDRESS,
                from_address: "0x3000000000000000000000000000000000000000",
                to_address: "0x4000000000000000000000000000000000000000",
                payload_json: JSON.stringify({ orderKind: "seaport" }),
            },
        ]);
    });

    it("coalesces repeated listing creates below the price threshold and stays idempotent per source event", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const collectionId = insertCollection(chainId, "alpha", contract);
        const domain = new SqliteActivityDomain();

        await domain.handleActivityUpsert({
            chainId,
            collectionId,
            scopeKind: "token",
            kind: "listing_created",
            contract,
            tokenId: "1",
            occurredAt: 1_700_000_200,
            sourceKind: "offchain",
            sourceName: "opensea",
            sourceEventKey: "stream:event:1",
            orderId: "order-1",
            maker: "0x3000000000000000000000000000000000000000",
            side: "sell",
            amount: "1",
            price: "1000000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
        });
        await domain.handleActivityUpsert({
            chainId,
            collectionId,
            scopeKind: "token",
            kind: "listing_created",
            contract,
            tokenId: "1",
            occurredAt: 1_700_000_260,
            sourceKind: "offchain",
            sourceName: "opensea",
            sourceEventKey: "stream:event:2",
            orderId: "order-2",
            maker: "0x3000000000000000000000000000000000000000",
            side: "sell",
            amount: "1",
            price: "999500000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
        });
        await domain.handleActivityUpsert({
            chainId,
            collectionId,
            scopeKind: "token",
            kind: "listing_created",
            contract,
            tokenId: "1",
            occurredAt: 1_700_000_200,
            sourceKind: "offchain",
            sourceName: "opensea",
            sourceEventKey: "stream:event:1",
            orderId: "order-1",
            maker: "0x3000000000000000000000000000000000000000",
            side: "sell",
            amount: "1",
            price: "1000000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
        });

        const activities = db
            .prepare<
                [number]
            >("SELECT id, order_id, price, occurred_at, is_open FROM activities WHERE chain_id = ? ORDER BY id ASC")
            .all(chainId) as Array<{
            id: number;
            order_id: string | null;
            price: string | null;
            occurred_at: number;
            is_open: number;
        }>;
        const sourceCount = db
            .prepare<
                [number]
            >("SELECT COUNT(*) AS count FROM activity_sources WHERE chain_id = ?")
            .get(chainId) as { count: number };

        expect(activities).toEqual([
            {
                id: activities[0]!.id,
                order_id: "order-2",
                price: "999500000000000000",
                occurred_at: 1_700_000_260,
                is_open: 1,
            },
        ]);
        expect(sourceCount.count).toBe(2);
    });

    it("creates a new listing row once the price delta crosses the threshold", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const collectionId = insertCollection(chainId, "alpha", contract);
        const domain = new SqliteActivityDomain();

        await domain.handleActivityUpsert({
            chainId,
            collectionId,
            scopeKind: "token",
            kind: "listing_created",
            contract,
            tokenId: "1",
            occurredAt: 1_700_000_200,
            sourceKind: "offchain",
            sourceName: "opensea",
            sourceEventKey: "stream:event:1",
            orderId: "order-1",
            maker: "0x3000000000000000000000000000000000000000",
            side: "sell",
            amount: "1",
            price: "1000000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
        });
        await domain.handleActivityUpsert({
            chainId,
            collectionId,
            scopeKind: "token",
            kind: "listing_created",
            contract,
            tokenId: "1",
            occurredAt: 1_700_000_300,
            sourceKind: "offchain",
            sourceName: "opensea",
            sourceEventKey: "stream:event:2",
            orderId: "order-2",
            maker: "0x3000000000000000000000000000000000000000",
            side: "sell",
            amount: "1",
            price: "998000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
        });

        const rows = db
            .prepare<
                [number]
            >("SELECT order_id, price, occurred_at, is_open FROM activities WHERE chain_id = ? ORDER BY occurred_at ASC, id ASC")
            .all(chainId) as Array<{
            order_id: string | null;
            price: string | null;
            occurred_at: number;
            is_open: number;
        }>;

        expect(rows).toEqual([
            {
                order_id: "order-1",
                price: "1000000000000000000",
                occurred_at: 1_700_000_200,
                is_open: 0,
            },
            {
                order_id: "order-2",
                price: "998000000000000000",
                occurred_at: 1_700_000_300,
                is_open: 1,
            },
        ]);
    });

    it("closes open listing rows on offchain cancellation and on onchain sale", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const collectionId = insertCollection(chainId, "alpha", contract);
        const domain = new SqliteActivityDomain();

        await domain.handleActivityUpsert({
            chainId,
            collectionId,
            scopeKind: "token",
            kind: "listing_created",
            contract,
            tokenId: "1",
            occurredAt: 1_700_000_200,
            sourceKind: "offchain",
            sourceName: "opensea",
            sourceEventKey: "stream:event:1",
            orderId: "order-1",
            maker: "0x3000000000000000000000000000000000000000",
            side: "sell",
            amount: "1",
            price: "1000000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
        });
        await domain.handleActivityUpsert({
            chainId,
            collectionId,
            scopeKind: "token",
            kind: "listing_cancelled",
            contract,
            tokenId: "1",
            occurredAt: 1_700_000_250,
            sourceKind: "offchain",
            sourceName: "opensea",
            sourceEventKey: "stream:event:2",
            orderId: "order-1",
            maker: "0x3000000000000000000000000000000000000000",
            side: "sell",
            amount: "1",
            price: "1000000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_cancelled" },
        });

        await domain.handleActivityUpsert({
            chainId,
            collectionId,
            scopeKind: "token",
            kind: "listing_created",
            contract,
            tokenId: "1",
            occurredAt: 1_700_000_260,
            sourceKind: "offchain",
            sourceName: "opensea",
            sourceEventKey: "stream:event:3",
            orderId: "order-2",
            maker: "0x3000000000000000000000000000000000000000",
            side: "sell",
            amount: "1",
            price: "998000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
        });
        insertFill({
            chainId,
            collectionId,
            contract,
            tokenId: "1",
            orderId: "order-2",
            side: "sell",
            maker: "0x3000000000000000000000000000000000000000",
            taker: "0x4000000000000000000000000000000000000000",
            amount: "1",
            price: "998000000000000000",
            currency: ZERO_ADDRESS,
            blockNumber: 101,
            blockTimestamp: 1_700_000_400,
            txHash: "0xtx-sale",
            logIndex: 2,
            kind: "seaport",
        });

        await domain.handleDomainSync({
            chainId,
            collectionId: null,
            fromBlock: 101,
            toBlock: 101,
            mode: "backfill",
            projection: DOMAIN_SYNC_PROJECTION.FactsOnly,
            sourceJobId: "test-job",
            sourceKind: "test",
        });

        const rows = db
            .prepare<
                [number]
            >("SELECT kind, order_id, is_open FROM activities WHERE chain_id = ? ORDER BY occurred_at ASC, id ASC")
            .all(chainId) as Array<{
            kind: string;
            order_id: string | null;
            is_open: number;
        }>;

        expect(rows).toEqual([
            {
                kind: "listing_created",
                order_id: "order-1",
                is_open: 0,
            },
            {
                kind: "listing_cancelled",
                order_id: "order-1",
                is_open: 0,
            },
            {
                kind: "listing_created",
                order_id: "order-2",
                is_open: 0,
            },
            {
                kind: "sale",
                order_id: "order-2",
                is_open: 0,
            },
        ]);
    });
});

function insertCollection(
    chainId: number,
    slug: string,
    address: string,
): number {
    const result = db
        .prepare<
            [number, string, string]
        >("INSERT INTO collections " + "(chain_id, slug, address, standard, status, token_scope_kind, created_at, updated_at) " + "VALUES (?, ?, ?, 'erc721', 'live', 'contract_all_tokens', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
        .run(chainId, slug, address.toLowerCase());

    return Number(result.lastInsertRowid);
}

function insertCollectionExtensionEvent(input: {
    chainId: number;
    collectionId: number;
    extensionKey: string;
    eventKey: string;
    contract: string;
    tokenId: string;
    maker: string;
    contentHash: string | null;
    blockNumber: number;
    blockTimestamp: number;
    txHash: string;
    logIndex: number;
    payload: Record<string, unknown>;
}): void {
    db.prepare<{
        chainId: number;
        collectionId: number;
        extensionKey: string;
        eventKey: string;
        contractAddress: string;
        tokenId: string;
        maker: string;
        contentHash: string | null;
        blockNumber: number;
        blockHash: string;
        blockTimestamp: number;
        txHash: string;
        logIndex: number;
        payloadJson: string;
    }>(
        "INSERT INTO collection_extension_events " +
            "(chain_id, collection_id, extension_key, event_key, contract_address, token_id, maker, content_hash, block_number, block_hash, block_timestamp, tx_hash, log_index, payload_json) " +
            "VALUES (@chainId, @collectionId, @extensionKey, @eventKey, @contractAddress, @tokenId, @maker, @contentHash, @blockNumber, @blockHash, @blockTimestamp, @txHash, @logIndex, @payloadJson)",
    ).run({
        chainId: input.chainId,
        collectionId: input.collectionId,
        extensionKey: input.extensionKey,
        eventKey: input.eventKey,
        contractAddress: input.contract.toLowerCase(),
        tokenId: input.tokenId,
        maker: input.maker.toLowerCase(),
        contentHash: input.contentHash?.toLowerCase() ?? null,
        blockNumber: input.blockNumber,
        blockHash: `0xblock-${input.blockNumber}`,
        blockTimestamp: input.blockTimestamp,
        txHash: input.txHash,
        logIndex: input.logIndex,
        payloadJson: JSON.stringify(input.payload),
    });
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
    blockTimestamp: number;
    txHash: string;
    logIndex: number;
    standard: "erc721" | "erc1155";
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
            string,
        ]
    >(
        "INSERT INTO nft_transfer_events " +
            "(chain_id, collection_id, contract_address, from_address, to_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index, kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        input.blockTimestamp,
        input.txHash,
        input.logIndex,
        input.standard,
    );
}

function insertFill(input: {
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    orderId?: string;
    side: string;
    maker: string;
    taker: string;
    amount: string;
    price: string;
    currency: string;
    blockNumber: number;
    blockTimestamp: number;
    txHash: string;
    logIndex: number;
    kind: string;
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
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        input.chainId,
        input.collectionId,
        input.kind,
        input.orderId ?? `order-${input.txHash}`,
        input.side,
        input.maker.toLowerCase(),
        input.taker.toLowerCase(),
        input.contract.toLowerCase(),
        input.tokenId,
        input.amount,
        input.price,
        input.currency.toLowerCase(),
        input.blockNumber,
        `0xblock-${input.blockNumber}`,
        input.blockTimestamp,
        input.txHash,
        input.logIndex,
    );
}
