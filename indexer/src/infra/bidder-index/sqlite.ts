import { db } from "@artgod/shared/database";
import type { BidderIndexPort } from "../../ports/bidder-index.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../../domain/orders.js";

type MakerRow = { maker: string };

export class SqliteBidderIndex implements BidderIndexPort {
    private selectMakers = db.prepare<
        [number, string, string, string, string, number]
    >(
        "SELECT DISTINCT maker FROM orders WHERE chain_id = ? " +
            "AND side = 'buy' AND maker IS NOT NULL " +
            "AND source_status=? AND fillability_status IN (?,?,?) AND (valid_until IS NULL OR valid_until>?)",
    );

    async load(chainId: number): Promise<Set<string>> {
        const makers = new Set<string>();
        for (const row of this.selectMakers.iterate(
            chainId,
            ORDER_SOURCE_STATUS.Active,
            ORDER_STATUS.Fillable,
            ORDER_STATUS.NoBalance,
            ORDER_STATUS.NoApproval,
            Math.floor(Date.now() / 1000),
        ) as Iterable<MakerRow>) {
            if (!row.maker) continue;
            makers.add(row.maker.toLowerCase());
        }
        return makers;
    }
}
