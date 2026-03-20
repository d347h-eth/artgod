import { db } from "@artgod/shared/database";
import type { OrderSourceScopeKind } from "../../domain/orders.js";

type OrderActivityLookupRow = {
    side: "buy" | "sell" | null;
    source_scope_kind: OrderSourceScopeKind | null;
    contract_address: string;
    token_id: string | null;
    maker: string;
    taker: string | null;
    price: string | null;
    currency: string | null;
};

export type OrderActivityLookupResult = {
    side: "buy" | "sell" | null;
    sourceScopeKind: OrderSourceScopeKind | null;
    contract: string;
    tokenId: string | null;
    maker: string;
    taker: string | null;
    price: string | null;
    currency: string | null;
};

export class SqliteOrderActivityLookup {
    private selectOrder = db.prepare<{
        chainId: number;
        orderId: string;
    }>(
        "SELECT side, source_scope_kind, contract_address, token_id, maker, taker, price, currency " +
            "FROM orders WHERE chain_id = @chainId AND id = @orderId LIMIT 1",
    );

    getByOrderId(params: {
        chainId: number;
        orderId: string;
    }): OrderActivityLookupResult | null {
        const row = this.selectOrder.get(params) as
            | OrderActivityLookupRow
            | undefined;
        if (!row) return null;
        return {
            side: row.side,
            sourceScopeKind: row.source_scope_kind,
            contract: row.contract_address.toLowerCase(),
            tokenId: row.token_id,
            maker: row.maker.toLowerCase(),
            taker: row.taker?.toLowerCase() ?? null,
            price: row.price,
            currency: row.currency?.toLowerCase() ?? null,
        };
    }
}
