import type Database from "better-sqlite3";

export const ORDER_EVIDENCE_FIXTURE = {
    anchorBlock: 90,
    proofBlock: 100,
    revision: 0,
    hash: `0x${"64".padStart(64, "0")}`,
    anchorHash: `0x${"5a".padStart(64, "0")}`,
} as const;

/** Read-adapter fixture over the real migrated schema. Explicitly supplies an
 * already accepted checkpoint; this does not test acquisition or coordinator
 * application, whose tests must use the real applied-range writer. The fixture
 * supplies known positive quantity/capacity when the caller omitted them; tests
 * for missing/zero quantities must explicitly replace them after this seed. */
export function seedOrderEvidence(
    conn: Database.Database,
    orderId: string,
    nowMs: number,
): void {
    const order = conn
        .prepare("SELECT chain_id,collection_id FROM orders WHERE id=?")
        .get(orderId) as
        | { chain_id: number; collection_id: number }
        | undefined;
    if (!order) throw new Error("Evidence fixture requires an existing order");
    const f = ORDER_EVIDENCE_FIXTURE;
    conn.transaction(() => {
        conn.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE chain_id=? AND collection_id=?",
        ).run(f.anchorBlock, order.chain_id, order.collection_id);
        for (const [number, hash] of [
            [f.anchorBlock, f.anchorHash],
            [f.proofBlock, f.hash],
        ] as const)
            conn.prepare(
                "INSERT OR IGNORE INTO blocks(chain_id,block_number,block_hash,parent_hash,timestamp) VALUES (?,?,?,?,?)",
            ).run(
                order.chain_id,
                number,
                hash,
                f.anchorHash,
                Math.floor(nowMs / 1_000),
            );
        conn.prepare(
            "INSERT OR IGNORE INTO chain_sync_progress(chain_id,revision,anchor_block,anchor_hash,applied_block,applied_hash) VALUES (?,?,?,?,?,?)",
        ).run(
            order.chain_id,
            f.revision,
            f.anchorBlock,
            f.anchorHash,
            f.proofBlock,
            f.hash,
        );
        conn.prepare(
            "INSERT OR IGNORE INTO collection_ownership_bases(chain_id,collection_id,run_id,revision,anchor_block,anchor_hash) VALUES (?,?,1,?,?,?)",
        ).run(
            order.chain_id,
            order.collection_id,
            f.revision,
            f.anchorBlock,
            f.anchorHash,
        );
        conn.prepare(
            "INSERT OR IGNORE INTO collection_sync_progress(chain_id,collection_id,revision,anchor_block,anchor_hash,applied_block,applied_hash) VALUES (?,?,?,?,?,?,?)",
        ).run(
            order.chain_id,
            order.collection_id,
            f.revision,
            f.anchorBlock,
            f.anchorHash,
            f.proofBlock,
            f.hash,
        );
        conn.prepare(
            "UPDATE orders SET quantity=COALESCE(quantity,'1'),fillable_quantity=COALESCE(fillable_quantity,quantity,'1'),validation_ready=1,proof_block_number=?,proof_block_hash=?,proof_chain_revision=?,proof_order_revision=state_revision,proof_admission_sequence=0,proof_at=? WHERE id=?",
        ).run(f.proofBlock, f.hash, f.revision, nowMs, orderId);
    })();
}
