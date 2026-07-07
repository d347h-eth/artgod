import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    TOKEN_ATTRIBUTE_SOURCE_KIND,
} from "@artgod/shared/types/token-attributes";
import {
    COLLECTION_PURGE_LATE_SCHEMA_TABLE,
    SqliteCollectionPurgeRepository,
} from "./sqlite-collection-purge-repository.js";

const COLLECTION_ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_COLLECTION_ADDRESS = "0x2222222222222222222222222222222222222222";
const OWNER_ADDRESS = "0x3333333333333333333333333333333333333333";
const MAKER_ADDRESS = "0x4444444444444444444444444444444444444444";
const PURGE_FIXTURE_EXTENSION_KEY = "test-extension";
const PURGE_FIXTURE_QUEUE_NAME = "metadata-stats";
const PURGE_FIXTURE_JOB_KIND = "domain.metadata.stats-recompute";
const PURGE_FIXTURE_REFRESH_REASON = "metadata-refresh";
const PURGE_FIXTURE_RUN_STATUS = "finalized";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-collection-purge-"));
    return join(dir, "main.sqlite");
}

describe("SqliteCollectionPurgeRepository", () => {
    let collectionId = 0;
    let otherCollectionId = 0;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
        collectionId = seedCollection("purge-target", COLLECTION_ADDRESS);
        otherCollectionId = seedCollection(
            "other-collection",
            OTHER_COLLECTION_ADDRESS,
        );
        seedCollectionScopedRows(collectionId, COLLECTION_ADDRESS);
        seedCollectionScopedRows(otherCollectionId, OTHER_COLLECTION_ADDRESS);
    });

    it("removes collection-scoped rows while preserving other collections", () => {
        const repository = new SqliteCollectionPurgeRepository();

        const deletedRows = repository.purgeCollectionData({
            chainId: 1,
            collectionId,
        });

        assert.ok(
            deletedRows.some(
                (row) => row.table === "collections" && row.rowCount === 1,
            ),
        );
        assert.equal(countRows("collections", collectionId), 0);
        assert.equal(countRows("tokens", collectionId), 0);
        assert.equal(countRows("orders", collectionId), 0);
        assert.equal(countRows("activities", collectionId), 0);
        assert.equal(countRows("bootstrap_runs", collectionId), 0);
        assert.equal(countRows("trading_jobs", collectionId), 0);
        assert.equal(countRows("token_extension_artifacts", collectionId), 0);
        assert.equal(
            countRows(
                COLLECTION_PURGE_LATE_SCHEMA_TABLE.SyntheticTokenRetirements,
                collectionId,
            ),
            0,
        );
        assert.equal(
            countRows(
                COLLECTION_PURGE_LATE_SCHEMA_TABLE.BiddingOrderCancellations,
                collectionId,
            ),
            0,
        );
        assert.equal(countRows("collection_sync_blocks", collectionId), 0);
        assert.equal(countRows("bootstrap_image_cache_tasks", collectionId), 0);
        assert.equal(countRows("token_image_cache", collectionId), 0);
        assert.equal(countRows("metadata_refresh_runs", collectionId), 0);
        assert.equal(
            countRows(
                "metadata_refresh_extension_artifact_tasks",
                collectionId,
            ),
            0,
        );
        assert.equal(countRows("queue_outbox", collectionId), 0);
        assert.equal(
            countRows("bootstrap_ownership_snapshot_tasks", collectionId),
            0,
        );
        assert.equal(
            countRows(
                "bootstrap_collection_extension_artifact_tasks",
                collectionId,
            ),
            0,
        );
        assert.equal(countActivitySources(collectionId), 0);
        assert.equal(countBootstrapRunSteps(collectionId), 0);
        assert.equal(countTradingJobChildren(collectionId), 0);

        assert.equal(countRows("collections", otherCollectionId), 1);
        assert.equal(countRows("tokens", otherCollectionId), 1);
        assert.equal(countRows("orders", otherCollectionId), 1);
        assert.equal(countRows("activities", otherCollectionId), 1);
        assert.equal(countRows("bootstrap_runs", otherCollectionId), 1);
        assert.equal(countRows("trading_jobs", otherCollectionId), 1);
        assert.equal(
            countRows("token_extension_artifacts", otherCollectionId),
            1,
        );
        assert.equal(
            countRows(
                COLLECTION_PURGE_LATE_SCHEMA_TABLE.SyntheticTokenRetirements,
                otherCollectionId,
            ),
            1,
        );
        assert.equal(
            countRows(
                COLLECTION_PURGE_LATE_SCHEMA_TABLE.BiddingOrderCancellations,
                otherCollectionId,
            ),
            1,
        );
        assert.equal(countRows("collection_sync_blocks", otherCollectionId), 1);
        assert.equal(
            countRows("bootstrap_image_cache_tasks", otherCollectionId),
            1,
        );
        assert.equal(countRows("token_image_cache", otherCollectionId), 1);
        assert.equal(countRows("metadata_refresh_runs", otherCollectionId), 1);
        assert.equal(
            countRows(
                "metadata_refresh_extension_artifact_tasks",
                otherCollectionId,
            ),
            1,
        );
        assert.equal(countRows("queue_outbox", otherCollectionId), 1);
        assert.equal(
            countRows("bootstrap_ownership_snapshot_tasks", otherCollectionId),
            1,
        );
        assert.equal(
            countRows(
                "bootstrap_collection_extension_artifact_tasks",
                otherCollectionId,
            ),
            1,
        );
        assert.equal(countActivitySources(otherCollectionId), 1);
        assert.equal(countBootstrapRunSteps(otherCollectionId), 1);
        assert.equal(countTradingJobChildren(otherCollectionId), 4);
    });
});

function seedCollection(slug: string, address: string): number {
    const result = db
        .prepare<{
            slug: string;
            address: string;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind, opensea_slug) " +
                "VALUES (1, @slug, @address, 'erc721', 'live', 'explicit_token_ids', @slug)",
        )
        .run({ slug, address });
    return Number(result.lastInsertRowid);
}

function seedCollectionScopedRows(collectionId: number, address: string): void {
    const runId = seedBootstrapRows(collectionId, address);
    const activityId = seedActivityRows(collectionId, address);
    const attributeKeyId = seedAttributeKey(collectionId, address);
    const attributeId = seedAttribute(collectionId, address, attributeKeyId);
    seedTokenRows(collectionId, address, attributeId);
    seedOnchainRows(collectionId, address);
    seedOrderRows(collectionId, address);
    seedOffchainRows(collectionId);
    seedExtensionRows(collectionId, address);
    seedTradingRows(collectionId);
    seedPostMigrationRows(collectionId, runId, address);

    db.prepare(
        "INSERT INTO activity_sources " +
            "(chain_id, source_kind, source_name, source_event_key, activity_id) " +
            "VALUES (1, 'offchain', 'opensea', ?, ?)",
    ).run(`activity-source:${collectionId}`, activityId);
    db.prepare(
        "INSERT INTO collection_scope_tokens (chain_id, collection_id, token_id) VALUES (1, ?, '1')",
    ).run(collectionId);
    db.prepare(
        "INSERT INTO bootstrap_metadata_snapshot_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status) " +
            "VALUES (?, 1, ?, ?, '1', 'erc721', 10, '0xanchor', 1000, 'completed')",
    ).run(runId, collectionId, address);
}

function seedPostMigrationRows(
    collectionId: number,
    runId: number,
    address: string,
): void {
    db.prepare(
        "INSERT INTO collection_sync_blocks " +
            "(chain_id, collection_id, block_number) VALUES (1, ?, 12)",
    ).run(collectionId);
    db.prepare(
        "INSERT INTO bootstrap_image_cache_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, source_image_url) " +
            "VALUES (?, 1, ?, ?, '1', ?)",
    ).run(
        runId,
        collectionId,
        address,
        `https://images.example/${collectionId}.png`,
    );
    db.prepare(
        "INSERT INTO token_image_cache " +
            "(chain_id, collection_id, token_id, source_image_url, requested_max_dimension, cache_key, content_type, source_bytes, cached_bytes, relative_path, public_path) " +
            "VALUES (1, ?, '1', ?, 512, ?, 'image/png', 10, 8, ?, ?)",
    ).run(
        collectionId,
        `https://images.example/${collectionId}.png`,
        `cache-${collectionId}`,
        `tokens/${collectionId}.png`,
        `/media/tokens/${collectionId}.png`,
    );
    db.prepare(
        "INSERT INTO bootstrap_ownership_snapshot_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp) " +
            "VALUES (?, 1, ?, ?, '1', 'erc721', 10, '0xanchor', 1000)",
    ).run(runId, collectionId, address);
    db.prepare(
        "INSERT INTO bootstrap_collection_extension_artifact_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, extension_key) " +
            "VALUES (?, 1, ?, ?, '1', ?)",
    ).run(runId, collectionId, address, PURGE_FIXTURE_EXTENSION_KEY);
    const refreshOutboxId = Number(
        db
            .prepare(
                "INSERT INTO queue_outbox " +
                    "(queue_name, job_id, job_kind, job_json, chain_id, collection_id) " +
                    "VALUES (?, ?, ?, ?, 1, ?)",
            )
            .run(
                PURGE_FIXTURE_QUEUE_NAME,
                `metadata-stats:${collectionId}`,
                PURGE_FIXTURE_JOB_KIND,
                JSON.stringify({ collectionId }),
                collectionId,
            ).lastInsertRowid,
    );
    db.prepare(
        "INSERT INTO metadata_refresh_runs " +
            "(run_id, chain_id, collection_id, reason, source_job_id, trace_id, stats_job_json, status, stats_queue_outbox_id) " +
            "VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        `metadata-refresh-run-${collectionId}`,
        collectionId,
        PURGE_FIXTURE_REFRESH_REASON,
        `metadata-refresh-job-${collectionId}`,
        `metadata-refresh-trace-${collectionId}`,
        JSON.stringify({ collectionId }),
        PURGE_FIXTURE_RUN_STATUS,
        refreshOutboxId,
    );
    db.prepare(
        "INSERT INTO metadata_refresh_extension_artifact_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, extension_key) " +
            "VALUES (?, 1, ?, ?, '1', ?)",
    ).run(
        `metadata-refresh-run-${collectionId}`,
        collectionId,
        address,
        PURGE_FIXTURE_EXTENSION_KEY,
    );
    db.prepare(
        "INSERT INTO bootstrap_run_steps (run_id, step_key) VALUES (?, ?)",
    ).run(runId, `test-step-${collectionId}`);
}

function seedBootstrapRows(collectionId: number, address: string): number {
    const runId = Number(
        db
            .prepare(
                "INSERT INTO bootstrap_runs " +
                    "(chain_id, collection_id, request_slug, request_address, request_standard, metadata_mode, enumeration_mode, status) " +
                    "VALUES (1, ?, ?, ?, 'erc721', 'strict', 'manual_token_ids', 'finished')",
            )
            .run(collectionId, `run-${collectionId}`, address).lastInsertRowid,
    );
    db.prepare(
        "INSERT INTO bootstrap_run_events " +
            "(run_id, chain_id, collection_id, event_code, event_level, message) " +
            "VALUES (?, 1, ?, 'test', 'info', 'test event')",
    ).run(runId, collectionId);
    db.prepare(
        "INSERT INTO nft_balance_snapshots " +
            "(run_id, chain_id, collection_id, contract_address, token_id, owner, anchor_block) " +
            "VALUES (?, 1, ?, ?, '1', ?, 10)",
    ).run(runId, collectionId, address, OWNER_ADDRESS);
    return runId;
}

function seedActivityRows(collectionId: number, address: string): number {
    return Number(
        db
            .prepare(
                "INSERT INTO activities " +
                    "(chain_id, collection_id, scope_kind, kind, contract_address, token_id, occurred_at, source_kind, source_name, dedupe_key) " +
                    "VALUES (1, ?, 'token', 'transfer', ?, '1', 1000, 'onchain', 'ethereum', ?)",
            )
            .run(collectionId, address, `activity:${collectionId}`)
            .lastInsertRowid,
    );
}

function seedAttributeKey(collectionId: number, address: string): number {
    return Number(
        db
            .prepare(
                "INSERT INTO attribute_keys (chain_id, collection_id, contract_address, key) " +
                    "VALUES (1, ?, ?, 'Type')",
            )
            .run(collectionId, address).lastInsertRowid,
    );
}

function seedAttribute(
    collectionId: number,
    address: string,
    attributeKeyId: number,
): number {
    return Number(
        db
            .prepare(
                "INSERT INTO attributes " +
                    "(chain_id, collection_id, contract_address, attribute_key_id, value) " +
                    "VALUES (1, ?, ?, ?, 'One')",
            )
            .run(collectionId, address, attributeKeyId).lastInsertRowid,
    );
}

function seedTokenRows(
    collectionId: number,
    address: string,
    attributeId: number,
): void {
    db.prepare(
        "INSERT INTO tokens (chain_id, collection_id, contract_address, token_id) " +
            "VALUES (1, ?, ?, '1')",
    ).run(collectionId, address);
    db.prepare(
        "INSERT INTO token_metadata " +
            "(chain_id, collection_id, contract_address, token_id, uri) " +
            "VALUES (1, ?, ?, '1', 'ipfs://token')",
    ).run(collectionId, address);
    db.prepare(
        "INSERT INTO token_attributes " +
            "(chain_id, collection_id, contract_address, token_id, attribute_id, source_kind, source_key) " +
            "VALUES (1, ?, ?, '1', ?, ?, ?)",
    ).run(
        collectionId,
        address,
        attributeId,
        TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
        TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    );
    db.prepare(
        "INSERT INTO collection_trait_stats " +
            "(chain_id, collection_id, contract_address, attribute_key_id, attribute_id, token_count) " +
            "SELECT 1, ?, ?, attribute_key_id, id, 1 FROM attributes WHERE id = ?",
    ).run(collectionId, address, attributeId);
    db.prepare(
        "INSERT INTO token_sets " +
            "(chain_id, collection_id, id, schema_hash, schema_json, contract_address, attribute_id) " +
            "VALUES (1, ?, 'set-1', 'hash-1', '{}', ?, ?)",
    ).run(collectionId, address, attributeId);
    db.prepare(
        "INSERT INTO token_sets_tokens " +
            "(chain_id, collection_id, token_set_id, token_set_schema_hash, contract_address, token_id) " +
            "VALUES (1, ?, 'set-1', 'hash-1', ?, '1')",
    ).run(collectionId, address);
}

function seedOnchainRows(collectionId: number, address: string): void {
    db.prepare(
        "INSERT INTO nft_balances " +
            "(chain_id, collection_id, contract_address, token_id, owner, amount, last_block_number, last_block_hash, last_block_timestamp, last_tx_hash, last_log_index) " +
            "VALUES (1, ?, ?, '1', ?, '1', 11, '0xblock', 1100, '0xtx', 1)",
    ).run(collectionId, address, OWNER_ADDRESS);
    db.prepare(
        "INSERT INTO nft_transfer_events " +
            "(chain_id, collection_id, contract_address, from_address, to_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index, kind) " +
            "VALUES (1, ?, ?, '0x0000000000000000000000000000000000000000', ?, '1', '1', 11, '0xblock', 1100, ?, 1, 'transfer')",
    ).run(collectionId, address, OWNER_ADDRESS, `0xtx${collectionId}`);
    db.prepare(
        "INSERT INTO fills " +
            "(chain_id, collection_id, kind, contract_address, token_id, block_number, block_hash, block_timestamp, tx_hash, log_index) " +
            "VALUES (1, ?, 'sale', ?, '1', 11, '0xblock', 1100, ?, 2)",
    ).run(collectionId, address, `0xfill${collectionId}`);
}

function seedOrderRows(collectionId: number, address: string): void {
    db.prepare(
        "INSERT INTO orders " +
            "(id, chain_id, collection_id, kind, side, source, maker, contract_address, token_id, price, currency, fillability_status, source_status) " +
            "VALUES (?, 1, ?, 'seaport', 'buy', 'opensea', ?, ?, '1', '100', ?, 'fillable', 'active')",
    ).run(
        `order-${collectionId}`,
        collectionId,
        MAKER_ADDRESS,
        address,
        address,
    );
}

function seedOffchainRows(collectionId: number): void {
    db.prepare(
        "INSERT INTO offchain_order_observations " +
            "(chain_id, collection_id, source, channel, dedupe_key, event_type, received_at, payload_json) " +
            "VALUES (1, ?, 'opensea', 'snapshot', ?, 'item_received_bid', 1000, '{}')",
    ).run(collectionId, `observation:${collectionId}`);
    db.prepare(
        "INSERT INTO opensea_orderbook_runs (chain_id, collection_id, kind, status) " +
            "VALUES (1, ?, 'snapshot', 'completed')",
    ).run(collectionId);
}

function seedExtensionRows(collectionId: number, address: string): void {
    db.prepare(
        "INSERT INTO collection_extension_installs " +
            "(chain_id, collection_id, extension_key, config_json) " +
            "VALUES (1, ?, 'test-extension', '{}')",
    ).run(collectionId);
    db.prepare(
        "INSERT INTO token_extension_artifacts " +
            "(chain_id, collection_id, contract_address, token_id, extension_key, artifact_ref) " +
            "VALUES (1, ?, ?, '1', 'test-extension', 'artifact')",
    ).run(collectionId, address);
    db.prepare(
        `INSERT INTO ${quoteIdentifier(COLLECTION_PURGE_LATE_SCHEMA_TABLE.SyntheticTokenRetirements)} ` +
            "(chain_id, collection_id, contract_address, token_id, extension_key) " +
            "VALUES (1, ?, ?, 'synthetic-1', 'test-extension')",
    ).run(collectionId, address);
    db.prepare(
        "INSERT INTO collection_extension_events " +
            "(chain_id, collection_id, extension_key, event_key, contract_address, token_id, block_number, block_hash, block_timestamp, tx_hash, log_index) " +
            "VALUES (1, ?, 'test-extension', 'event', ?, '1', 11, '0xblock', 1100, ?, 3)",
    ).run(collectionId, address, `0xevent${collectionId}`);
    db.prepare(
        "INSERT INTO collection_extension_event_media " +
            "(chain_id, collection_id, extension_key, event_key, contract_address, token_id, media_ref, block_number, block_hash, block_timestamp, tx_hash, log_index) " +
            "VALUES (1, ?, 'test-extension', 'event', ?, '1', 'media', 11, '0xblock', 1100, ?, 3)",
    ).run(collectionId, address, `0xevent${collectionId}`);
    db.prepare(
        "INSERT INTO collection_customization_features " +
            "(chain_id, collection_id, feature_key, selected_source, user_config_json) " +
            "VALUES (1, ?, 'traitFilterPresentation', 'user', '{}')",
    ).run(collectionId);
    db.prepare(
        "INSERT INTO collection_settings (chain_id, collection_id, setting_key, value_json) " +
            "VALUES (1, ?, 'setting', '{}')",
    ).run(collectionId);
}

function seedTradingRows(collectionId: number): void {
    const tierId = `tier-${collectionId}`;
    const jobId = `job-${collectionId}`;
    db.prepare(
        "INSERT INTO trading_bidding_price_tiers " +
            "(tier_id, chain_id, collection_id, name, status, sort_order, floor_config_json, ceiling_config_json) " +
            "VALUES (?, 1, ?, 'base', 'enabled', 1, '{}', '{}')",
    ).run(tierId, collectionId);
    db.prepare(
        "INSERT INTO trading_jobs " +
            "(job_id, bot_kind, chain_id, collection_id, status, target_kind, token_id) " +
            "VALUES (?, 'bidding', 1, ?, 'enabled', 'token', '1')",
    ).run(jobId, collectionId);
    db.prepare(
        "INSERT INTO trading_bidding_job_specs " +
            "(job_id, floor_wei, ceiling_wei, delta_wei, price_tier_id) " +
            "VALUES (?, '1', '2', '1', ?)",
    ).run(jobId, tierId);
    db.prepare(
        "INSERT INTO trading_bidding_job_runtime_state (job_id) VALUES (?)",
    ).run(jobId);
    db.prepare(
        `INSERT INTO ${quoteIdentifier(COLLECTION_PURGE_LATE_SCHEMA_TABLE.BiddingOrderCancellations)} ` +
            "(order_id, job_id, chain_id, collection_id, maker, requested_at) " +
            "VALUES (?, ?, 1, ?, ?, CURRENT_TIMESTAMP)",
    ).run(`cancel-${collectionId}`, jobId, collectionId, MAKER_ADDRESS);
    db.prepare(
        "INSERT INTO trading_job_commands " +
            "(job_id, bot_kind, command_kind, status, requested_revision, payload_json) " +
            "VALUES (?, 'bidding', 'job_created', 'pending', 1, '{}')",
    ).run(jobId);
    db.prepare(
        "INSERT INTO trading_bidding_bid_book_rows " +
            "(chain_id, collection_id, order_id, source, scope_kind, scope_label, maker, price_wei) " +
            "VALUES (1, ?, ?, 'orders', 'token', 'token #1', ?, '1')",
    ).run(collectionId, `bid-${collectionId}`, MAKER_ADDRESS);
    db.prepare(
        "INSERT INTO trading_bidding_collection_bid_book_state " +
            "(chain_id, collection_id, source) VALUES (1, ?, 'orders')",
    ).run(collectionId);
}

function countRows(table: string, collectionId: number): number {
    const row = db
        .prepare<
            [number]
        >(`SELECT COUNT(1) AS count FROM "${table}" WHERE collection_id = ?`)
        .get(collectionId) as { count: number } | undefined;
    return row?.count ?? 0;
}

function countActivitySources(collectionId: number): number {
    const row = db
        .prepare<
            [string]
        >("SELECT COUNT(1) AS count FROM activity_sources WHERE source_event_key = ?")
        .get(`activity-source:${collectionId}`) as
        | { count: number }
        | undefined;
    return row?.count ?? 0;
}

function countBootstrapRunSteps(collectionId: number): number {
    const row = db
        .prepare<
            [string]
        >("SELECT COUNT(1) AS count FROM bootstrap_run_steps WHERE step_key = ?")
        .get(`test-step-${collectionId}`) as { count: number } | undefined;
    return row?.count ?? 0;
}

function countTradingJobChildren(collectionId: number): number {
    const jobId = `job-${collectionId}`;
    const tables = [
        "trading_job_commands",
        "trading_bidding_job_runtime_state",
        "trading_bidding_job_specs",
        COLLECTION_PURGE_LATE_SCHEMA_TABLE.BiddingOrderCancellations,
    ];
    return tables.reduce((sum, table) => {
        const row = db
            .prepare<
                [string]
            >(`SELECT COUNT(1) AS count FROM "${table}" WHERE job_id = ?`)
            .get(jobId) as { count: number } | undefined;
        return sum + (row?.count ?? 0);
    }, 0);
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}
