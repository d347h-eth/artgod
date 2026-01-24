import { db } from "@artgod/shared/database";
import type { BidderIndexPort } from "../../ports/bidder-index.js";

type MakerRow = { maker: string };

export class SqliteBidderIndex implements BidderIndexPort {
    private selectMakers = db.prepare<[number]>(
        "SELECT DISTINCT maker FROM orders WHERE chain_id = ? " +
            "AND side = 'buy' AND maker IS NOT NULL " +
            "AND (fillability_status IS NULL OR fillability_status NOT IN ('filled', 'cancelled'))",
    );

    async load(chainId: number): Promise<Set<string>> {
        const rows = this.selectMakers.all(chainId) as MakerRow[];
        const makers = new Set<string>();
        for (const row of rows) {
            if (!row.maker) continue;
            makers.add(row.maker.toLowerCase());
        }
        return makers;
    }
}
