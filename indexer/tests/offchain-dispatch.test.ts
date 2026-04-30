import fs from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { dispatchOffchainPayload } from "../src/application/offchain/dispatch.js";
import {
    ACTIVITY_JOB_KIND,
    type ActivityUpsertPayload,
} from "../src/domain/activity-jobs.js";
import type { OffchainOrderRawPayload } from "../src/domain/offchain-jobs.js";
import {
    ORDER_JOB_KIND,
    type OrderUpsertPayload,
} from "../src/domain/order-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES, type QueueName } from "../src/domain/queues.js";
import { SqliteTokenSetRegistry } from "../src/infra/token-sets/sqlite.js";
import type {
    QueuePort,
    QueueMessage,
    SubscribeOptions,
} from "../src/ports/queue.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { resolveFixturePath } from "./helpers/fixture-paths.js";

const CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const MAKER = "0x255dcfa35b70fc60bfac74ffdfb4782b441a1963";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
const MISMATCH_ROOT =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("offchain dispatch", () => {
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
                "DELETE FROM orders;",
                "DELETE FROM collection_trait_stats;",
                "DELETE FROM token_sets_tokens;",
                "DELETE FROM token_sets;",
                "DELETE FROM token_attributes;",
                "DELETE FROM attributes;",
                "DELETE FROM attribute_keys;",
                "DELETE FROM tokens;",
                "DELETE FROM nft_balances;",
                "DELETE FROM collections;",
            ].join("\n"),
        );
    });

    it("persists REST collection offers even when source criteria root is zero", async () => {
        const collectionId = ensureCollection(1, CONTRACT);
        seedBalance(1, collectionId, CONTRACT, "10");
        seedBalance(1, collectionId, CONTRACT, "11");

        const queue = new QueueCapture();
        const tokenSets = new SqliteTokenSetRegistry();
        const payload: OffchainOrderRawPayload = {
            source: "opensea",
            chainId: 1,
            collectionId,
            receivedAt: Date.now(),
            channel: "snapshot",
            dedupeKey: "snapshot:test:collection-offer",
            eventType: "rest.offer.collection",
            orderId:
                "0xefa9f7ca972850e136c27f8599f4cc3a3acd853b90a7cd280392e4e9f83db92e",
            runId: 1,
            sourceEventAt: 1772907789,
            payload: buildRestCollectionOfferRecord(),
        };

        const result = await dispatchOffchainPayload(
            queue,
            tokenSets,
            new OrderActivityLookupStub(),
            payload,
        );

        expect(result).toEqual({
            handled: true,
            upsertedOrderId: payload.orderId,
        });
        expect(queue.published).toHaveLength(1);

        const upsert = queue.published[0] as JobEnvelope<OrderUpsertPayload>;
        expect(upsert.queue).toBe(QUEUE_NAMES.OrdersUpsert);
        expect(upsert.kind).toBe(ORDER_JOB_KIND.Upsert);
        expect(upsert.payload.sourceScopeKind).toBe("collection");
        expect(upsert.payload.sourceCriteriaRoot).toBe(ZERO_BYTES32);
        expect(upsert.payload.localTokenSetStatus).toBe("resolved");
        expect(upsert.payload.tokenSetId).not.toBeNull();
        expect(upsert.payload.rawSourceKind).toBe("rest");
        expect(upsert.payload.rawPayload).toEqual(
            buildRestCollectionOfferRecord(),
        );
    });

    it("persists REST numeric-trait offers through shared OpenSea bidding parser semantics", async () => {
        const collectionId = ensureCollection(1, CONTRACT);
        const queue = new QueueCapture();
        const tokenSets = new SqliteTokenSetRegistry();
        const payload: OffchainOrderRawPayload = {
            source: "opensea",
            chainId: 1,
            collectionId,
            receivedAt: Date.now(),
            channel: "snapshot",
            dedupeKey: "snapshot:test:numeric-trait-offer",
            eventType: "rest.offer.collection",
            orderId:
                "0xe42d30d10b52ac6e813d3ecb2e14bf79ccc61db4c65fc89d70cacb2ae9cfae52",
            runId: 1,
            sourceEventAt: 1773545938,
            payload: buildRestNumericTraitOfferRecord(),
        };

        const result = await dispatchOffchainPayload(
            queue,
            tokenSets,
            new OrderActivityLookupStub(),
            payload,
        );

        expect(result).toEqual({
            handled: true,
            upsertedOrderId: payload.orderId,
        });
        expect(queue.published).toHaveLength(1);

        const upsert = queue.published[0] as JobEnvelope<OrderUpsertPayload>;
        expect(upsert.payload.sourceScopeKind).toBe("attribute");
        expect(upsert.payload.sourceEncodedTokenIds).toBe("30,314,5108:5109");
        expect(upsert.payload.quantity).toBe("2");
        expect(upsert.payload.price).toBe("310000000000000000");
        expect(upsert.payload.sourceSchema).toEqual({
            kind: "attribute",
            data: {
                collection: CONTRACT,
                attributes: [{ key: "Biome", value: "42" }],
            },
        });
        expect(upsert.payload.localTokenSetStatus).toBe("unresolved");
        expect(upsert.payload.rawSourceKind).toBe("rest");
    });

    it("persists encoded token-set offers without collapsing them to collection scope", async () => {
        const collectionId = ensureCollection(1, CONTRACT);
        const queue = new QueueCapture();
        const tokenSets = new SqliteTokenSetRegistry();
        const payload: OffchainOrderRawPayload = {
            source: "opensea",
            chainId: 1,
            collectionId,
            receivedAt: Date.now(),
            channel: "snapshot",
            dedupeKey: "snapshot:test:token-set-offer",
            eventType: "rest.offer.collection",
            orderId:
                "0x111d30d10b52ac6e813d3ecb2e14bf79ccc61db4c65fc89d70cacb2ae9cfae52",
            runId: 1,
            sourceEventAt: 1773545938,
            payload: buildRestTokenSetOfferRecord(),
        };

        const result = await dispatchOffchainPayload(
            queue,
            tokenSets,
            new OrderActivityLookupStub(),
            payload,
        );

        expect(result).toEqual({
            handled: true,
            upsertedOrderId: payload.orderId,
        });
        expect(queue.published).toHaveLength(1);

        const upsert = queue.published[0] as JobEnvelope<OrderUpsertPayload>;
        expect(upsert.payload.sourceScopeKind).toBe("token_set");
        expect(upsert.payload.sourceEncodedTokenIds).toBe("30,314,5108:5109");
        expect(upsert.payload.sourceSchema).toBeNull();
        expect(upsert.payload.localTokenSetStatus).toBe("unresolved");
    });

    it("persists trait offers with local token-set mismatch instead of dropping them", async () => {
        const collectionId = ensureCollection(1, CONTRACT);
        seedAttribute(1, collectionId, CONTRACT, "Zone", "Mori");
        linkToken(1, collectionId, CONTRACT, "1", [["Zone", "Mori"]]);
        linkToken(1, collectionId, CONTRACT, "2", [["Zone", "Mori"]]);

        const queue = new QueueCapture();
        const tokenSets = new SqliteTokenSetRegistry();
        const payload: OffchainOrderRawPayload = {
            source: "opensea",
            chainId: 1,
            collectionId,
            receivedAt: Date.now(),
            channel: "stream",
            dedupeKey: "stream:test:trait-offer-mismatch",
            eventType: "trait_offer",
            orderId:
                "0xa8f60585a1aa2f7c78c1b64cc3583405d04eb288e01aebb1a76f4191525e2a87",
            runId: null,
            sourceEventAt: 1772748246,
            payload: buildStreamTraitOfferEnvelope(MISMATCH_ROOT),
        };

        const result = await dispatchOffchainPayload(
            queue,
            tokenSets,
            new OrderActivityLookupStub(),
            payload,
        );

        expect(result).toEqual({
            handled: true,
            upsertedOrderId: payload.orderId,
        });
        expect(queue.published).toHaveLength(1);

        const upsert = queue.published[0] as JobEnvelope<OrderUpsertPayload>;
        expect(upsert.payload.sourceScopeKind).toBe("attribute");
        expect(upsert.payload.sourceCriteriaRoot).toBe(MISMATCH_ROOT);
        expect(upsert.payload.localTokenSetStatus).toBe("mismatch");
        expect(upsert.payload.tokenSetId).toBeNull();
        expect(upsert.payload.tokenSetSchemaHash).toBeNull();
        expect(upsert.payload.rawSourceKind).toBe("stream");
    });

    it("publishes a listing activity upsert for stream item_listed", async () => {
        const collectionId = ensureCollection(1, CONTRACT);
        const queue = new QueueCapture();
        const tokenSets = new SqliteTokenSetRegistry();
        const fixture = await readFixture("item_listed.json");
        const payload: OffchainOrderRawPayload = {
            source: "opensea",
            chainId: 1,
            collectionId,
            receivedAt: Date.now(),
            channel: "stream",
            dedupeKey: "stream:test:item-listed",
            eventType: "item_listed",
            orderId: null,
            runId: null,
            sourceEventAt: 1_772_748_246,
            payload: fixture,
        };

        const result = await dispatchOffchainPayload(
            queue,
            tokenSets,
            new OrderActivityLookupStub(),
            payload,
        );

        expect(result).toEqual({
            handled: true,
            upsertedOrderId:
                "0x27c086e5028d11931d7fa0bc47762dbf22d3cee845d2cc9191d7686f0a2bcc9b",
        });

        const activityJob = queue.published.find(
            (job) => job.kind === ACTIVITY_JOB_KIND.Upsert,
        ) as JobEnvelope<ActivityUpsertPayload> | undefined;
        expect(activityJob).toBeDefined();
        expect(activityJob?.queue).toBe(QUEUE_NAMES.ActivityUpsert);
        expect(activityJob?.payload.kind).toBe("listing_created");
        expect(activityJob?.payload.scopeKind).toBe("token");
        expect(activityJob?.payload.tokenId).toBe("2522");
        expect(activityJob?.payload.side).toBe("sell");
    });

    it("publishes a listing cancellation activity when existing order context is token-scoped", async () => {
        const collectionId = ensureCollection(1, CONTRACT);
        const queue = new QueueCapture();
        const tokenSets = new SqliteTokenSetRegistry();
        const fixture = await readFixture("item_cancelled.json");
        const orderId =
            "0xe7385bf786154848873d89e0b4e2e03406e396ee9d3cb4da47f801f719c0a792";
        const payload: OffchainOrderRawPayload = {
            source: "opensea",
            chainId: 1,
            collectionId,
            receivedAt: Date.now(),
            channel: "stream",
            dedupeKey: "stream:test:item-cancelled",
            eventType: "item_cancelled",
            orderId,
            runId: null,
            sourceEventAt: 1_650_559_606,
            payload: fixture,
        };

        const result = await dispatchOffchainPayload(
            queue,
            tokenSets,
            new OrderActivityLookupStub({
                [orderId]: {
                    side: "sell",
                    sourceScopeKind: "token",
                    contract: CONTRACT,
                    tokenId: "1",
                    maker: MAKER,
                    taker: null,
                    price: "24840000000000000000",
                    currency: ZERO_ADDRESS,
                },
            }),
            payload,
        );

        expect(result).toEqual({
            handled: true,
            upsertedOrderId: null,
        });

        const activityJob = queue.published.find(
            (job) => job.kind === ACTIVITY_JOB_KIND.Upsert,
        ) as JobEnvelope<ActivityUpsertPayload> | undefined;
        expect(activityJob).toBeDefined();
        expect(activityJob?.payload.kind).toBe("listing_cancelled");
        expect(activityJob?.payload.tokenId).toBe("1");
        expect(activityJob?.payload.side).toBe("sell");
    });
});

class QueueCapture implements QueuePort {
    readonly published: Array<JobEnvelope<unknown>> = [];

    async publish<TPayload>(
        _queue: QueueName,
        message: JobEnvelope<TPayload>,
    ): Promise<void> {
        this.published.push(message as JobEnvelope<unknown>);
    }

    async subscribe<TPayload>(
        _queue: QueueName,
        _handler: (message: QueueMessage<TPayload>) => Promise<void>,
        _options: SubscribeOptions,
    ): Promise<() => Promise<void>> {
        throw new Error("not implemented");
    }

    async close(): Promise<void> {}
}

class OrderActivityLookupStub {
    constructor(
        private readonly rows: Record<
            string,
            {
                side: "buy" | "sell" | null;
                sourceScopeKind: string | null;
                contract: string;
                tokenId: string | null;
                maker: string;
                taker: string | null;
                price: string | null;
                currency: string | null;
            }
        > = {},
    ) {}

    getByOrderId(params: { orderId: string }) {
        return this.rows[params.orderId] ?? null;
    }
}

function buildRestCollectionOfferRecord(): Record<string, unknown> {
    return {
        status: "ACTIVE",
        order_hash:
            "0xefa9f7ca972850e136c27f8599f4cc3a3acd853b90a7cd280392e4e9f83db92e",
        protocol_address: SEAPORT,
        protocol_data: {
            parameters: {
                offerer: MAKER,
                offer: [
                    {
                        itemType: 1,
                        token: WETH,
                        identifierOrCriteria: "0",
                        startAmount: "157000000000000000",
                        endAmount: "157000000000000000",
                    },
                ],
                consideration: [
                    {
                        itemType: 4,
                        token: CONTRACT,
                        identifierOrCriteria: "0",
                        startAmount: "1",
                        endAmount: "1",
                        recipient: MAKER,
                    },
                    {
                        itemType: 1,
                        token: WETH,
                        identifierOrCriteria: "0",
                        startAmount: "1570000000000000",
                        endAmount: "1570000000000000",
                        recipient: "0x0000a26b00c1f0df003000390027140000faa719",
                    },
                ],
                startTime: "1772907789",
                endTime: "1772908389",
                orderType: 2,
                zone: "0x000056f7000000ece9003ca63978907a00ffd100",
                zoneHash: ZERO_BYTES32,
                salt: "1",
                conduitKey:
                    "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
                totalOriginalConsiderationItems: 2,
                counter: "0x0",
            },
            signature: null,
        },
        price: {
            value: "157000000000000000",
        },
        criteria: {
            contract: {
                address: CONTRACT,
            },
        },
    };
}

function buildRestNumericTraitOfferRecord(): Record<string, unknown> {
    return {
        status: "ACTIVE",
        order_hash:
            "0xe42d30d10b52ac6e813d3ecb2e14bf79ccc61db4c65fc89d70cacb2ae9cfae52",
        protocol_address: SEAPORT,
        protocol_data: {
            parameters: {
                offerer: MAKER,
                offer: [
                    {
                        itemType: 1,
                        token: WETH,
                        identifierOrCriteria: "0",
                        startAmount: "620000000000000000",
                        endAmount: "620000000000000000",
                    },
                ],
                consideration: [
                    {
                        itemType: 4,
                        token: CONTRACT,
                        identifierOrCriteria:
                            "113703377976973476812273708665395356499261988770439230068849221413098206214838",
                        startAmount: "2",
                        endAmount: "2",
                        recipient: MAKER,
                    },
                    {
                        itemType: 1,
                        token: WETH,
                        identifierOrCriteria: "0",
                        startAmount: "6200000000000000",
                        endAmount: "6200000000000000",
                        recipient:
                            "0x0000a26b00c1f0df003000390027140000faa719",
                    },
                ],
                startTime: "1773545938",
                endTime: "1789097938",
                orderType: 3,
                zone: "0x000056f7000000ece9003ca63978907a00ffd100",
                zoneHash: ZERO_BYTES32,
                salt: "3",
                conduitKey:
                    "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
                totalOriginalConsiderationItems: 2,
                counter: "0x0",
            },
            signature: null,
        },
        remaining_quantity: 2,
        price: {
            value: "620000000000000000",
        },
        criteria: {
            contract: {
                address: CONTRACT,
            },
            numeric_traits: [{ type: "Biome", min: 42, max: 42 }],
            encoded_token_ids: "30,314,5108:5109",
        },
    };
}

function buildRestTokenSetOfferRecord(): Record<string, unknown> {
    return {
        ...buildRestNumericTraitOfferRecord(),
        order_hash:
            "0x111d30d10b52ac6e813d3ecb2e14bf79ccc61db4c65fc89d70cacb2ae9cfae52",
        criteria: {
            contract: {
                address: CONTRACT,
            },
            encoded_token_ids: "30,314,5108:5109",
        },
    };
}

async function readFixture(file: string): Promise<Record<string, unknown>> {
    const fixturePath = resolveFixturePath(
        import.meta.url,
        "opensea-event-payloads",
        file,
    );
    const raw = await fs.readFile(fixturePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
}

function buildStreamTraitOfferEnvelope(
    criteriaRoot: string,
): Record<string, unknown> {
    return {
        event_type: "trait_offer",
        payload: {
            collection: {
                slug: "terraforms",
            },
            maker: {
                address: MAKER,
            },
            base_price: "381000000000000000",
            payment_token: {
                address: WETH,
            },
            created_date: "2026-03-05T22:04:06.000Z",
            expiration_date: "2026-03-08T07:00:00.000Z",
            order_hash:
                "0xa8f60585a1aa2f7c78c1b64cc3583405d04eb288e01aebb1a76f4191525e2a87",
            protocol_address: SEAPORT,
            event_timestamp: "2026-03-05T22:04:06.000Z",
            asset_contract_criteria: {
                address: CONTRACT,
            },
            trait_criteria: {
                trait_type: "Zone",
                trait_name: "Mori",
            },
            trait_criteria_list: [
                {
                    trait_type: "Zone",
                    trait_name: "Mori",
                },
            ],
            protocol_data: {
                parameters: {
                    offerer: MAKER,
                    offer: [
                        {
                            itemType: 1,
                            token: WETH,
                            identifierOrCriteria: "0",
                            startAmount: "381000000000000000",
                            endAmount: "381000000000000000",
                        },
                    ],
                    consideration: [
                        {
                            itemType: 4,
                            token: CONTRACT,
                            identifierOrCriteria: criteriaRoot,
                            startAmount: "1",
                            endAmount: "1",
                            recipient: MAKER,
                        },
                    ],
                    startTime: "1772748246",
                    endTime: "1772953200",
                    orderType: 2,
                    zone: ZERO_ADDRESS,
                    zoneHash: ZERO_BYTES32,
                    salt: "2",
                    conduitKey:
                        "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
                    totalOriginalConsiderationItems: 1,
                    counter: "0",
                },
                signature:
                    "0x25add8eee522a1b508de05cc55c958dee10c435b007a1a542b3da01a95b718b57dd5fb58a6126ef8a523fab09509b385771b33f5bce39447da822a5a4f73466f1c",
            },
        },
    };
}

function seedAttribute(
    chainId: number,
    collectionId: number,
    contractAddress: string,
    key: string,
    value: string,
): void {
    db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        key: string;
    }>(
        "INSERT OR IGNORE INTO attribute_keys (chain_id, collection_id, contract_address, key) VALUES (@chainId, @collectionId, @contractAddress, @key)",
    ).run({ chainId, collectionId, contractAddress, key });

    const keyRow = db
        .prepare<{
            chainId: number;
            collectionId: number;
            key: string;
        }>(
            "SELECT id FROM attribute_keys WHERE chain_id = @chainId AND collection_id = @collectionId AND key = @key",
        )
        .get({ chainId, collectionId, key }) as { id: number };

    db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        attributeKeyId: number;
        value: string;
    }>(
        "INSERT OR IGNORE INTO attributes (chain_id, collection_id, contract_address, attribute_key_id, value) VALUES (@chainId, @collectionId, @contractAddress, @attributeKeyId, @value)",
    ).run({
        chainId,
        collectionId,
        contractAddress,
        attributeKeyId: keyRow.id,
        value,
    });
}

function linkToken(
    chainId: number,
    collectionId: number,
    contractAddress: string,
    tokenId: string,
    pairs: Array<[string, string]>,
): void {
    db.prepare(
        "INSERT OR IGNORE INTO tokens (chain_id, collection_id, contract_address, token_id) VALUES (@chainId, @collectionId, @contractAddress, @tokenId)",
    ).run({ chainId, collectionId, contractAddress, tokenId });

    for (const [key, value] of pairs) {
        const keyRow = db
            .prepare<{
                chainId: number;
                collectionId: number;
                key: string;
            }>(
                "SELECT id FROM attribute_keys WHERE chain_id = @chainId AND collection_id = @collectionId AND key = @key",
            )
            .get({ chainId, collectionId, key }) as { id: number };

        const attrRow = db
            .prepare<{
                chainId: number;
                collectionId: number;
                attributeKeyId: number;
                value: string;
            }>(
                "SELECT id FROM attributes WHERE chain_id = @chainId AND collection_id = @collectionId AND attribute_key_id = @attributeKeyId AND value = @value",
            )
            .get({
                chainId,
                collectionId,
                attributeKeyId: keyRow.id,
                value,
            }) as { id: number };

        db.prepare(
            "INSERT OR IGNORE INTO token_attributes (chain_id, collection_id, contract_address, token_id, attribute_id) VALUES (@chainId, @collectionId, @contractAddress, @tokenId, @attributeId)",
        ).run({
            chainId,
            collectionId,
            contractAddress,
            tokenId,
            attributeId: attrRow.id,
        });
    }
}

function seedBalance(
    chainId: number,
    collectionId: number,
    contract: string,
    tokenId: string,
): void {
    db.prepare(
        "INSERT OR REPLACE INTO nft_balances " +
            "(chain_id, collection_id, contract_address, token_id, owner, amount, last_block_number, last_block_hash, " +
            "last_block_timestamp, last_tx_hash, last_log_index) " +
            "VALUES (@chainId, @collectionId, @contract, @tokenId, @owner, @amount, @blockNumber, @blockHash, @blockTimestamp, @txHash, @logIndex)",
    ).run({
        chainId,
        collectionId,
        contract,
        tokenId,
        owner: MAKER,
        amount: "1",
        blockNumber: 1,
        blockHash: "0xhash",
        blockTimestamp: 1,
        txHash: "0xtx",
        logIndex: 0,
    });
}

function ensureCollection(chainId: number, contractAddress: string): number {
    const existing = db
        .prepare<
            [number, string]
        >("SELECT collection_id FROM collections WHERE chain_id = ? AND lower(address) = ? LIMIT 1")
        .get(chainId, contractAddress.toLowerCase()) as
        | { collection_id: number }
        | undefined;
    if (existing) {
        return existing.collection_id;
    }

    const inserted = db
        .prepare<
            [number, string, string]
        >("INSERT INTO collections " + "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply) " + "VALUES (?, ?, ?, 'erc721', 'live', 'contract_all_tokens', NULL, NULL)")
        .run(
            chainId,
            `fixture-${contractAddress.slice(2, 10).toLowerCase()}`,
            contractAddress.toLowerCase(),
        );
    return Number(inserted.lastInsertRowid);
}
