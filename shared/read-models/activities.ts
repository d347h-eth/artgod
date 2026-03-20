import { DEFAULT_PAGE_LIMIT } from "../config/pagination.js";
import { db } from "../database/db.js";
import type {
    ActivityFeedCursor,
    ActivityFeedItem,
    ActivityFeedPage,
} from "../types/activity-feed.js";
import { decodeOpaqueCursor, encodeOpaqueCursor } from "../utils/cursor.js";
import { ReadModelBadRequestError } from "./errors.js";

type ActivityRow = {
    id: number;
    scope_kind: string;
    kind: string;
    contract_address: string;
    token_id: string | null;
    occurred_at: number;
    source_kind: string;
    source_name: string;
    order_id: string | null;
    block_number: number | null;
    tx_hash: string | null;
    log_index: number | null;
    from_address: string | null;
    to_address: string | null;
    maker: string | null;
    taker: string | null;
    side: string | null;
    amount: string | null;
    price: string | null;
    currency: string | null;
    payload_json: string | null;
};

export class SqliteActivitiesReadModel {
    listCollectionActivities(params: {
        chainId: number;
        collectionId: number;
        limit: number;
        cursor?: string;
    }): ActivityFeedPage {
        return this.listActivities({
            chainId: params.chainId,
            collectionId: params.collectionId,
            limit: params.limit,
            cursor: params.cursor,
        });
    }

    listTokenActivities(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        limit: number;
        cursor?: string;
    }): ActivityFeedPage {
        const tokenId = params.tokenId.trim();
        if (!tokenId) {
            throw new ReadModelBadRequestError("Invalid token_ref");
        }

        return this.listActivities({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenId,
            limit: params.limit,
            cursor: params.cursor,
        });
    }

    private listActivities(params: {
        chainId: number;
        collectionId: number;
        tokenId?: string;
        limit: number;
        cursor?: string;
    }): ActivityFeedPage {
        const limit = normalizeLimit(params.limit);
        const cursor =
            params.cursor !== undefined
                ? decodeActivityCursor(params.cursor)
                : null;
        const whereClauses = [
            "chain_id = ?",
            "collection_id = ?",
            ...(params.tokenId ? ["token_id = ?"] : []),
        ];
        const values: unknown[] = [
            params.chainId,
            params.collectionId,
            ...(params.tokenId ? [params.tokenId] : []),
        ];

        if (cursor) {
            whereClauses.push(
                "(occurred_at < ? OR (occurred_at = ? AND id < ?))",
            );
            values.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
        }

        const rows = db.raw
            .prepare(
                "SELECT id, scope_kind, kind, contract_address, token_id, occurred_at, source_kind, source_name, order_id, block_number, tx_hash, log_index, from_address, to_address, maker, taker, side, amount, price, currency, payload_json " +
                    "FROM activities " +
                    `WHERE ${whereClauses.join(" AND ")} ` +
                    "ORDER BY occurred_at DESC, id DESC LIMIT ?",
            )
            .all(...values, limit + 1) as ActivityRow[];
        const hasNext = rows.length > limit;
        const pageRows = hasNext ? rows.slice(0, limit) : rows;
        const items = pageRows.map(mapActivityRow);
        const nextCursor = hasNext
            ? encodeOpaqueCursor({
                  occurredAt: pageRows[pageRows.length - 1]!.occurred_at,
                  id: pageRows[pageRows.length - 1]!.id,
              })
            : null;

        return {
            items,
            nextCursor,
            limit,
        };
    }
}

function normalizeLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new ReadModelBadRequestError("Invalid limit");
    }
    return limit || DEFAULT_PAGE_LIMIT;
}

function decodeActivityCursor(cursor: string): ActivityFeedCursor {
    try {
        const decoded = decodeOpaqueCursor<ActivityFeedCursor>(cursor);
        if (
            !decoded ||
            !Number.isInteger(decoded.occurredAt) ||
            !Number.isInteger(decoded.id) ||
            decoded.id <= 0
        ) {
            throw new Error("Invalid cursor");
        }
        return decoded;
    } catch {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
}

function mapActivityRow(row: ActivityRow): ActivityFeedItem {
    return {
        id: row.id,
        scopeKind: row.scope_kind as ActivityFeedItem["scopeKind"],
        kind: row.kind as ActivityFeedItem["kind"],
        contract: row.contract_address.toLowerCase(),
        tokenId: row.token_id,
        occurredAt: row.occurred_at,
        sourceKind: row.source_kind as ActivityFeedItem["sourceKind"],
        sourceName: row.source_name,
        orderId: row.order_id,
        blockNumber: row.block_number,
        txHash: row.tx_hash,
        logIndex: row.log_index,
        from: row.from_address?.toLowerCase() ?? null,
        to: row.to_address?.toLowerCase() ?? null,
        maker: row.maker?.toLowerCase() ?? null,
        taker: row.taker?.toLowerCase() ?? null,
        side: row.side === "buy" || row.side === "sell" ? row.side : null,
        amount: row.amount,
        price: row.price,
        currency: row.currency?.toLowerCase() ?? null,
        payload: parsePayloadJson(row.payload_json),
    };
}

function parsePayloadJson(
    payloadJson: string | null,
): Record<string, unknown> | null {
    if (!payloadJson) return null;
    try {
        const parsed = JSON.parse(payloadJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}
