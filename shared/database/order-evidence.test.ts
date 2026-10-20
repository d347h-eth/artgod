import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "./db.js";
import { createMigrationRunner } from "./migrations.js";
import { SqliteCurrentAsks } from "./current-asks.js";
import { usableOrderEvidenceSql } from "./order-evidence.js";
import {
    ORDER_SIDE,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    ORDER_SOURCE_SCOPE_KIND,
} from "../market-data/orders.js";
import { FILL_KIND } from "../market-data/fills.js";
import {
    GLOBAL_MAKER_TRIGGER_REASON,
    MAKER_REVALIDATION_STATUS,
    MAKER_TRIGGER_SCOPE,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
} from "../market-data/order-validation.js";
import { MARKET_DATA_STORAGE_POLICY } from "../market-data/storage-policy.js";
import { COLLECTION_STANDARD, COLLECTION_STATUS } from "../types/browse.js";
import {
    ORDER_EVIDENCE_FIXTURE,
    seedOrderEvidence,
} from "../testing/order-evidence.js";

const CHAIN = 1;
const COLLECTION = 99;
const MAKER = `0x${"1".repeat(40)}`;
const WETH = `0x${"2".repeat(40)}`;
const NOW = 1_800_000_000_000;

function addOrder(id: string, side: string = ORDER_SIDE.Sell, token = "1") {
    db.prepare(
        "INSERT INTO orders(id,chain_id,collection_id,kind,side,source,maker,contract_address,token_id,source_scope_kind,price,currency,quantity,source_status,fillability_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
        id,
        CHAIN,
        COLLECTION,
        FILL_KIND.Seaport,
        side,
        "fixture",
        MAKER,
        MAKER,
        token,
        ORDER_SOURCE_SCOPE_KIND.Token,
        "100",
        WETH,
        "1",
        ORDER_SOURCE_STATUS.Active,
        ORDER_STATUS.Fillable,
    );
    seedOrderEvidence(db.raw, id, NOW);
}

function visible(id = "ask", now = NOW): boolean {
    return !!db
        .prepare(
            `SELECT 1 FROM orders o WHERE o.id=? AND ${usableOrderEvidenceSql({ orderAlias: "o", nowMs: "?" })}`,
        )
        .get(id, now);
}

function makerScope(
    input: {
        scope?: string;
        reason?: string;
        block?: number | null;
        revision?: number;
        token?: string;
        currency?: string;
    } = {},
) {
    const block = input.block === undefined ? 101 : input.block;
    const requiredHash =
        block === null ? null : `0x${block.toString(16).padStart(64, "0")}`;
    if (block !== null && block > ORDER_EVIDENCE_FIXTURE.proofBlock) {
        db.prepare(
            "INSERT OR IGNORE INTO blocks(chain_id,block_number,block_hash,parent_hash,timestamp) VALUES (1,?,?,?,?)",
        ).run(block, requiredHash, ORDER_EVIDENCE_FIXTURE.hash, NOW / 1_000);
        db.prepare(
            "UPDATE chain_sync_progress SET applied_block=?,applied_hash=?",
        ).run(block, requiredHash);
        db.prepare(
            "UPDATE collection_sync_progress SET applied_block=?,applied_hash=?",
        ).run(block, requiredHash);
    }
    db.prepare(
        "INSERT INTO maker_order_revalidation_runs(run_id,chain_id,source_job_id,payload_json,status,upper_order_id,upper_rowid,created_at,updated_at,scope_kind,scope_maker,scope_collection_id,scope_token_id,scope_reason,scope_currency,required_chain_revision,required_block_number,required_block_hash,requested_admission_sequence) VALUES ('scope',?,'scope','{}',?,'z',100,0,0,?,?,?,?,?,?,?,?,?,?)",
    ).run(
        CHAIN,
        MAKER_REVALIDATION_STATUS.Pending,
        input.scope ?? MAKER_TRIGGER_SCOPE.Token,
        MAKER,
        COLLECTION,
        input.token ?? "1",
        input.reason ?? TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
        input.currency ?? WETH,
        input.revision ?? 0,
        block,
        requiredHash,
        block === null ? 1 : 0,
    );
}

describe("shared order evidence eligibility", () => {
    beforeEach(async () => {
        setDbPath(
            join(
                mkdtempSync(join(tmpdir(), "order-evidence-")),
                "fixture.sqlite",
            ),
        );
        await createMigrationRunner().runMigrations();
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind) VALUES (?,?, 'evidence',?,?,?,'contract_all_tokens')",
        ).run(
            COLLECTION,
            CHAIN,
            MAKER,
            COLLECTION_STANDARD.Erc721,
            COLLECTION_STATUS.Live,
        );
        addOrder("ask");
    });

    it("uses current independent proof after demand receipts are deleted", () => {
        expect(visible()).toBe(true);
        const asks = new SqliteCurrentAsks(db.raw, [WETH]);
        expect(
            asks.forSeller(CHAIN, COLLECTION, "1", MAKER, NOW / 1_000)?.id,
        ).toBe("ask");
        db.prepare(
            "INSERT INTO order_validation_demand(order_id,chain_id,revision,required_at,pending,updated_at) VALUES ('ask',1,0,0,0,0)",
        ).run();
        expect(visible()).toBe(true);
        db.prepare(
            "DELETE FROM order_validation_demand WHERE order_id='ask'",
        ).run();
        expect(visible()).toBe(true);
    });

    for (const [reason, mutation] of [
        ["unready declaration", "UPDATE orders SET validation_ready=0"],
        ["unknown remaining quantity", "UPDATE orders SET quantity=NULL"],
        ["unknown funded capacity", "UPDATE orders SET fillable_quantity=NULL"],
        ["zero remaining quantity", "UPDATE orders SET quantity='000'"],
        ["zero funded capacity", "UPDATE orders SET fillable_quantity='0'"],
        ["negative remaining quantity", "UPDATE orders SET quantity='-1'"],
        [
            "malformed funded capacity",
            "UPDATE orders SET fillable_quantity='1e3'",
        ],
        ["missing proof", "UPDATE orders SET proof_block_number=NULL"],
        [
            "changed declaration",
            "UPDATE orders SET state_revision=state_revision+1",
        ],
        ["wrong hash", "UPDATE orders SET proof_block_hash='replacement'"],
        [
            "deleted retained member",
            "DELETE FROM blocks WHERE block_number=100",
        ],
        [
            "new chain revision",
            "INSERT INTO chain_sync_revisions(chain_id,revision) VALUES (1,1)",
        ],
        [
            "shared prefix behind",
            "UPDATE chain_sync_progress SET applied_block=99",
        ],
        [
            "collection prefix behind",
            "UPDATE collection_sync_progress SET applied_block=99",
        ],
        [
            "changed collection anchor",
            "UPDATE collections SET bootstrap_anchor_block=91 WHERE collection_id=99",
        ],
        ["disputed view", "UPDATE chain_sync_progress SET disputed_from=100"],
        [
            "pending ordinary requirement",
            "INSERT INTO order_validation_demand(order_id,chain_id,revision,required_at,updated_at) VALUES ('ask',1,0,0,0)",
        ],
    ]) {
        it(`hides ${reason} from both proof reads and current asks`, () => {
            expect(visible()).toBe(true);
            db.exec(mutation!);
            expect(visible()).toBe(false);
            expect(
                new SqliteCurrentAsks(db.raw, [WETH]).forSeller(
                    CHAIN,
                    COLLECTION,
                    "1",
                    MAKER,
                    NOW / 1_000,
                ),
            ).toBeUndefined();
        });
    }

    it("preserves large positive decimal quantities without numeric coercion", () => {
        const maximum = ((1n << 256n) - 1n).toString();
        db.prepare("UPDATE orders SET quantity=?,fillable_quantity=?").run(
            maximum,
            maximum,
        );
        expect(visible()).toBe(true);
        expect(
            new SqliteCurrentAsks(db.raw, [WETH]).forSeller(
                CHAIN,
                COLLECTION,
                "1",
                MAKER,
                NOW / 1_000,
            )?.quantity,
        ).toBe(maximum);
    });

    it("hides both ancestor recovery and resync until recovery completes", () => {
        db.prepare(
            "INSERT INTO chain_reorg_recoveries(chain_id,recovery_id,version,revision,checked_block,stored_hash,observed_hash,phase,retry_at) VALUES (1,'recovery',0,0,100,'old','new','awaiting_ancestor',0)",
        ).run();
        expect(visible()).toBe(false);
        db.prepare(
            "UPDATE chain_reorg_recoveries SET phase='resync',range_from=91,range_to=100,target_block=100",
        ).run();
        expect(visible()).toBe(false);
        db.prepare("DELETE FROM chain_reorg_recoveries").run();
        expect(visible()).toBe(true);
    });

    it("expires proof at the existing bounded freshness interval", () => {
        const lifetime =
            MARKET_DATA_STORAGE_POLICY.orderRevalidationSeconds * 1_000;
        expect(visible("ask", NOW + lifetime - 1)).toBe(true);
        expect(visible("ask", NOW + lifetime)).toBe(false);
    });

    it("retains a token invalidation before expansion without blocking unrelated orders", () => {
        addOrder("other-token", ORDER_SIDE.Sell, "2");
        addOrder("bid", ORDER_SIDE.Buy);
        makerScope();
        expect(visible()).toBe(false);
        expect(visible("other-token")).toBe(true);
        expect(visible("bid")).toBe(true);
        db.prepare("UPDATE maker_order_revalidation_runs SET status=?").run(
            MAKER_REVALIDATION_STATUS.Completed,
        );
        expect(visible()).toBe(true);
    });

    it("blocks collection sells and only the applicable global funding currency", () => {
        addOrder("bid", ORDER_SIDE.Buy);
        addOrder("other-token", ORDER_SIDE.Sell, "2");
        makerScope({ scope: MAKER_TRIGGER_SCOPE.Collection });
        expect(visible("other-token")).toBe(false);
        expect(visible("bid")).toBe(true);
        db.prepare(
            "UPDATE maker_order_revalidation_runs SET scope_kind=?,scope_reason=?",
        ).run(
            MAKER_TRIGGER_SCOPE.Global,
            GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
        );
        expect(visible()).toBe(true);
        expect(visible("bid")).toBe(false);
        db.prepare(
            "UPDATE maker_order_revalidation_runs SET scope_currency='different'",
        ).run();
        expect(visible("bid")).toBe(true);
        db.prepare(
            "UPDATE maker_order_revalidation_runs SET scope_reason=?",
        ).run(GLOBAL_MAKER_TRIGGER_REASON.OrderCounter);
        expect(visible()).toBe(false);
        expect(visible("bid")).toBe(false);
    });

    it("lets a canonical proof cover its scope before the finite maker pass finishes", () => {
        makerScope();
        expect(visible()).toBe(false);
        db.prepare(
            "UPDATE orders SET proof_block_number=101,proof_block_hash=(SELECT required_block_hash FROM maker_order_revalidation_runs)",
        ).run();
        expect(visible()).toBe(true);
        db.prepare(
            "UPDATE maker_order_revalidation_runs SET required_block_hash='different'",
        ).run();
        expect(visible()).toBe(false);
    });

    it("requires the newest source admission in the current revision without waiting for expansion", () => {
        makerScope({ block: null });
        expect(visible()).toBe(false);
        db.prepare("UPDATE orders SET proof_admission_sequence=1").run();
        expect(visible()).toBe(true);
        db.prepare(
            "UPDATE maker_order_revalidation_runs SET requested_admission_sequence=2",
        ).run();
        expect(visible()).toBe(false);
        db.prepare(
            "INSERT INTO chain_sync_revisions(chain_id,revision) VALUES (1,1)",
        ).run();
        db.prepare("UPDATE chain_sync_progress SET revision=1").run();
        db.prepare("UPDATE collection_sync_progress SET revision=1").run();
        db.prepare("UPDATE orders SET proof_chain_revision=1").run();
        expect(visible()).toBe(false);
        db.prepare("UPDATE orders SET proof_admission_sequence=2").run();
        expect(visible()).toBe(true);
    });

    it("ignores pre-anchor canonical invalidations and preserves source invalidations across rollback", () => {
        makerScope({ block: ORDER_EVIDENCE_FIXTURE.anchorBlock });
        expect(visible()).toBe(true);
        db.prepare(
            "UPDATE maker_order_revalidation_runs SET required_block_number=100,required_chain_revision=1",
        ).run();
        expect(visible()).toBe(true);
        db.prepare(
            "UPDATE maker_order_revalidation_runs SET required_block_number=NULL,required_block_hash=NULL,requested_admission_sequence=1",
        ).run();
        expect(visible()).toBe(false);
    });
});
