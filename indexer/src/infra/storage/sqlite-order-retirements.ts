import type {
    BetterSqlite3Database,
    BetterSqlite3Statement,
} from "@artgod/shared/database";
import {
    mergeOrderRetirement,
    type OrderRetirement,
    type OrderRetirementObservation,
} from "../../domain/order-retention.js";

type StoredRetirement = OrderRetirement & { blockNumber: number | null };

/** Shared persistence for source updates and order cleanup. Callers own the
 * transaction coupling each marker with its associated order change. */
export class SqliteOrderRetirements {
    private readonly select: BetterSqlite3Statement;
    private readonly remove: BetterSqlite3Statement;
    private readonly upsert: BetterSqlite3Statement;

    constructor(conn: BetterSqlite3Database) {
        this.select = conn.prepare(
            "SELECT reason,retired_at AS retiredAt,valid_until AS validUntil,expires_at AS expiresAt,block_number AS blockNumber FROM market_order_retirements WHERE chain_id=? AND order_id=?",
        );
        this.remove = conn.prepare(
            "DELETE FROM market_order_retirements WHERE chain_id=? AND order_id=?",
        );
        this.upsert = conn.prepare(
            "INSERT INTO market_order_retirements(chain_id,collection_id,order_id,reason,retired_at,valid_until,expires_at,block_number) VALUES (?,?,?,?,?,?,?,?) " +
                "ON CONFLICT(chain_id,order_id) DO UPDATE SET reason=excluded.reason,retired_at=excluded.retired_at,valid_until=excluded.valid_until,expires_at=excluded.expires_at,block_number=excluded.block_number " +
                "WHERE reason IS NOT excluded.reason OR retired_at IS NOT excluded.retired_at OR valid_until IS NOT excluded.valid_until OR expires_at IS NOT excluded.expires_at OR block_number IS NOT excluded.block_number",
        );
    }

    find(chainId: number, orderId: string): StoredRetirement | undefined {
        return this.select.get(chainId, orderId) as
            | StoredRetirement
            | undefined;
    }

    record(
        input: OrderRetirementObservation & {
            chainId: number;
            collectionId: number;
            orderId: string;
            blockNumber?: number | null;
        },
        now: number,
    ): number {
        const previous = this.find(input.chainId, input.orderId);
        const next = mergeOrderRetirement(previous, input, now);
        // Nothing remains to protect once the known deadline has passed.
        if (next.expiresAt <= now)
            return previous ? this.forget(input.chainId, input.orderId) : 0;
        return this.upsert.run(
            input.chainId,
            input.collectionId,
            input.orderId,
            next.reason,
            next.retiredAt,
            next.validUntil,
            next.expiresAt,
            input.blockNumber ?? previous?.blockNumber ?? null,
        ).changes;
    }

    forget(chainId: number, orderId: string): number {
        return this.remove.run(chainId, orderId).changes;
    }
}
