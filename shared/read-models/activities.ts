import {
    DEFAULT_PAGE_LIMIT,
    MAX_PAGE_LIMIT,
} from "../config/pagination.js";
import { db } from "../database/db.js";
import type {
    ActivityFeedCursor,
    ActivityFeedFilterKind,
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

type ActivityCursorKey = {
    occurredAt: number;
    id: number;
};

export class SqliteActivitiesReadModel {
    listCollectionActivities(params: {
        chainId: number;
        collectionId: number;
        limit: number;
        cursor?: string;
        kind?: ActivityFeedFilterKind;
    }): ActivityFeedPage {
        return this.listActivities({
            chainId: params.chainId,
            collectionId: params.collectionId,
            limit: params.limit,
            cursor: params.cursor,
            kind: params.kind,
        });
    }

    listTokenActivities(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        limit: number;
        cursor?: string;
        kind?: ActivityFeedFilterKind;
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
            kind: params.kind,
        });
    }

    private listActivities(params: {
        chainId: number;
        collectionId: number;
        tokenId?: string;
        limit: number;
        cursor?: string;
        kind?: ActivityFeedFilterKind;
    }): ActivityFeedPage {
        const limit = normalizeLimit(params.limit);
        const filterKind = params.kind ?? null;
        const cursor =
            params.cursor !== undefined
                ? decodeActivityCursor(params.cursor, filterKind)
                : null;
        const { whereClauses: baseWhereClauses, values: baseValues } =
            buildActivityWhereClauses({
                chainId: params.chainId,
                collectionId: params.collectionId,
                tokenId: params.tokenId,
                kind: filterKind,
            });
        const whereClauses = [...baseWhereClauses];
        const values: unknown[] = [...baseValues];

        if (cursor) {
            whereClauses.push(buildActivityAfterCursorWhereClause());
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
        const prevCursor = deriveActivityPrevCursor({
            baseWhereClauses,
            baseValues,
            cursor,
            pageRows,
            limit,
            filterKind,
        });
        const totalItems = countMatchingActivities(baseWhereClauses, baseValues);
        const beforeItems = cursor
            ? countMatchingActivities(
                  [
                      ...baseWhereClauses,
                      buildActivityBeforeOrAtCursorWhereClause(),
                  ],
                  [...baseValues, cursor.occurredAt, cursor.occurredAt, cursor.id],
              )
            : 0;
        const rangeStart = items.length === 0 ? 0 : beforeItems + 1;
        const rangeEnd = beforeItems + items.length;
        const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
        const currentPage =
            totalItems === 0 ? 0 : Math.floor(beforeItems / limit) + 1;
        const nextCursor = hasNext
            ? encodeActivityCursor({
                  filterKind,
                  occurredAt: pageRows[pageRows.length - 1]!.occurred_at,
                  id: pageRows[pageRows.length - 1]!.id,
              })
            : null;

        return {
            items,
            prevCursor,
            nextCursor,
            limit,
            totalItems,
            rangeStart,
            rangeEnd,
            currentPage,
            totalPages,
        };
    }
}

function buildActivityWhereClauses(params: {
    chainId: number;
    collectionId: number;
    tokenId?: string;
    kind: ActivityFeedFilterKind | null;
}): {
    whereClauses: string[];
    values: unknown[];
} {
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

    switch (params.kind) {
        case "sales":
            whereClauses.push("kind = 'sale'");
            break;
        case "listings":
            whereClauses.push(
                "(kind = 'listing_created' OR kind = 'listing_cancelled')",
            );
            break;
        case "transfers":
            whereClauses.push("kind = 'transfer'");
            break;
    }

    return {
        whereClauses,
        values,
    };
}

function buildActivityAfterCursorWhereClause(): string {
    return "(occurred_at < ? OR (occurred_at = ? AND id < ?))";
}

function buildActivityBeforeCursorWhereClause(): string {
    return "(occurred_at > ? OR (occurred_at = ? AND id > ?))";
}

function buildActivityBeforeOrAtCursorWhereClause(): string {
    return "(occurred_at > ? OR (occurred_at = ? AND id >= ?))";
}

function countMatchingActivities(
    whereClauses: string[],
    values: unknown[],
): number {
    const row = db.raw
        .prepare(
            "SELECT COUNT(*) AS count FROM activities " +
                `WHERE ${whereClauses.join(" AND ")}`,
        )
        .get(...values) as { count: number | bigint } | undefined;
    if (!row) return 0;
    return typeof row.count === "bigint" ? Number(row.count) : row.count;
}

function deriveActivityPrevCursor(params: {
    baseWhereClauses: string[];
    baseValues: unknown[];
    cursor: ActivityFeedCursor | null;
    pageRows: ActivityRow[];
    limit: number;
    filterKind: ActivityFeedFilterKind | null;
}): string | null {
    const { baseWhereClauses, baseValues, cursor, pageRows, limit, filterKind } =
        params;
    const anchor = toAnchorCursorKey(pageRows, cursor);
    if (!anchor) return null;

    const previousRows = db.raw
        .prepare(
            "SELECT id, occurred_at FROM activities " +
                `WHERE ${baseWhereClauses.join(" AND ")} AND ${buildActivityBeforeCursorWhereClause()} ` +
                "ORDER BY occurred_at ASC, id ASC LIMIT ?",
        )
        .all(
            ...baseValues,
            anchor.occurredAt,
            anchor.occurredAt,
            anchor.id,
            limit + 1,
        ) as Array<{ id: number; occurred_at: number }>;

    if (previousRows.length <= limit) {
        return null;
    }

    return encodeActivityCursor({
        filterKind,
        occurredAt: previousRows[limit]!.occurred_at,
        id: previousRows[limit]!.id,
    });
}

function toAnchorCursorKey(
    pageRows: ActivityRow[],
    cursor: ActivityFeedCursor | null,
): ActivityCursorKey | null {
    const occurredAt = pageRows[0]?.occurred_at ?? cursor?.occurredAt ?? null;
    const id = pageRows[0]?.id ?? cursor?.id ?? null;
    if (!Number.isInteger(occurredAt) || !Number.isInteger(id) || id <= 0) {
        return null;
    }
    return {
        occurredAt,
        id,
    };
}

function normalizeLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new ReadModelBadRequestError("Invalid limit");
    }
    return Math.min(limit || DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
}

function decodeActivityCursor(
    cursor: string,
    expectedFilterKind: ActivityFeedFilterKind | null,
): ActivityFeedCursor {
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
        const cursorFilterKind = normalizeFilterKind(decoded.filterKind);
        if (cursorFilterKind !== expectedFilterKind) {
            throw new Error("Cursor filter mismatch");
        }
        return {
            occurredAt: decoded.occurredAt,
            id: decoded.id,
            filterKind: cursorFilterKind,
        };
    } catch {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
}

function normalizeFilterKind(
    value: ActivityFeedFilterKind | null | undefined,
): ActivityFeedFilterKind | null {
    return value === "sales" || value === "listings" || value === "transfers"
        ? value
        : null;
}

function encodeActivityCursor(cursor: ActivityFeedCursor): string {
    return encodeOpaqueCursor(cursor);
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
