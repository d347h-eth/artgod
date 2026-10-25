import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    COLLECTION_STANDARD,
    COLLECTION_STATUS,
    OPENSEA_COLLECTION_STATUS,
    OPENSEA_STREAM_INGESTION_STATUS,
} from "@artgod/shared/types";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { SqliteBootstrapRunsRepository } from "./sqlite-bootstrap-runs.js";

const ADDRESS = `0x${"12".repeat(20)}`;
const SLUG = "reset-market-readiness";

describe("new bootstrap marketplace state", () => {
    beforeAll(async () => {
        setDbPath(
            join(
                await mkdtemp(join(tmpdir(), "bootstrap-opensea-reset-")),
                "test.sqlite",
            ),
        );
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        db.exec("DELETE FROM collections");
        db.prepare(
            `INSERT INTO collections(collection_id,chain_id,slug,address,standard,token_scope_kind,status,opensea_slug,opensea_status,opensea_stream_ingestion_status,
            opensea_ready_at,opensea_snapshot_started_at,opensea_snapshot_completed_at,opensea_reconcile_started_at,opensea_reconcile_completed_at,
            opensea_last_stream_event_at,opensea_last_stream_healthy_at,opensea_last_error)
            VALUES (91,1,?,?,'erc721','contract_all_tokens',?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'old failure')`,
        ).run(
            SLUG,
            ADDRESS,
            COLLECTION_STATUS.Prepared,
            SLUG,
            OPENSEA_COLLECTION_STATUS.Ready,
            OPENSEA_STREAM_INGESTION_STATUS.Paused,
        );
    });

    it.each(["prepared", "definition"])(
        "clears readiness and freshness but preserves source identity and operator pause for %s starts",
        (path) => {
            const repository = new SqliteBootstrapRunsRepository();
            if (path === "prepared")
                repository.markCollectionBootstrapping(1, 91);
            else
                repository.upsertCollectionForBootstrap({
                    chainId: 1,
                    slug: SLUG,
                    address: ADDRESS,
                    openseaSlug: null,
                    standard: COLLECTION_STANDARD.Erc721,
                    tokenScopeKind:
                        EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
                    scopeStartTokenId: null,
                    scopeTotalSupply: null,
                    explicitTokenIds: [],
                    deploymentBlock: null,
                });
            const state = db
                .prepare(
                    "SELECT status,opensea_slug,opensea_stream_ingestion_status,opensea_status,opensea_ready_at,opensea_snapshot_started_at,opensea_snapshot_completed_at,opensea_reconcile_started_at,opensea_reconcile_completed_at,opensea_last_stream_event_at,opensea_last_stream_healthy_at,opensea_last_error FROM collections WHERE collection_id=91",
                )
                .get();
            expect(state).toEqual({
                status: COLLECTION_STATUS.Bootstrapping,
                opensea_slug: SLUG,
                opensea_stream_ingestion_status:
                    OPENSEA_STREAM_INGESTION_STATUS.Paused,
                opensea_status: null,
                opensea_ready_at: null,
                opensea_snapshot_started_at: null,
                opensea_snapshot_completed_at: null,
                opensea_reconcile_started_at: null,
                opensea_reconcile_completed_at: null,
                opensea_last_stream_event_at: null,
                opensea_last_stream_healthy_at: null,
                opensea_last_error: null,
            });
        },
    );
});
