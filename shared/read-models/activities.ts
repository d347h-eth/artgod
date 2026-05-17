import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../config/pagination.js";
import { db } from "../database/db.js";
import {
    ARTGOD_ACTIVITY_COUNT_KIND,
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_TRACE_ATTRIBUTE_VALUE,
} from "../observability/artgod-span-attributes.js";
import {
    NOOP_APM,
    type ApmPort,
    type SpanAttributes,
} from "../observability/apm.js";
import {
    ACTIVITY_FEED_FILTER_KIND,
    ACTIVITY_KIND,
    ACTIVITY_SOURCE_KIND,
    type ActivityEventMedia,
    type ActivityFeedCursor,
    type ActivityExtensionEventFilter,
    type ActivityFeedFilterKind,
    type ActivityFeedItem,
    type ActivityFeedPage,
} from "../types/activity-feed.js";
import type { TraitFilter, TraitRangeFilter } from "../types/browse.js";
import { decodeOpaqueCursor, encodeOpaqueCursor } from "../utils/cursor.js";
import { ReadModelBadRequestError } from "./errors.js";
import {
    groupTraitFilters,
    groupTraitRangeFilters,
    normalizeTraitFilters,
    normalizeTraitRangeFilters,
    resolveTraitFilterTokenCandidatesWithSpan,
    type TraitFilterGroup,
    type TraitRangeFilterGroup,
} from "./trait-filters.js";
import { buildTokenCandidateWhereClauses } from "./token-candidates.js";

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
    is_collapsed: number | null;
    collapsed_event_count: number | null;
    collapsed_window_start_utc: number | null;
    collapsed_window_end_utc: number | null;
};

type ActivityCursorKey = {
    occurredAt: number;
    id: number;
};

type ActivityQuerySource = {
    name: string;
    cteSql: string;
    relationSql: string;
    selectColumnsSql: string;
};

type ActivityEventMediaRow = {
    activity_id: number;
    media_ref: string;
    image: string | null;
    animation_url: string | null;
    html_content: string | null;
    render_modes_json: string | null;
};

const RAW_ACTIVITY_SELECT_COLUMNS =
    "id, scope_kind, kind, contract_address, token_id, occurred_at, source_kind, source_name, order_id, block_number, tx_hash, log_index, from_address, to_address, maker, taker, side, amount, price, currency, payload_json, " +
    "0 AS is_collapsed, NULL AS collapsed_event_count, NULL AS collapsed_window_start_utc, NULL AS collapsed_window_end_utc";

const COLLAPSED_ACTIVITY_SELECT_COLUMNS =
    "id, scope_kind, kind, contract_address, token_id, occurred_at, source_kind, source_name, order_id, block_number, tx_hash, log_index, from_address, to_address, maker, taker, side, amount, price, currency, payload_json, " +
    "is_collapsed, collapsed_event_count, collapsed_window_start_utc, collapsed_window_end_utc";

const RAW_ACTIVITY_SOURCE: ActivityQuerySource = {
    name: "raw",
    cteSql: "",
    relationSql: "FROM activities a",
    selectColumnsSql: RAW_ACTIVITY_SELECT_COLUMNS,
};

export class SqliteActivitiesReadModel {
    constructor(private readonly apm: ApmPort = NOOP_APM) {}

    listCollectionActivities(params: {
        chainId: number;
        collectionId: number;
        limit: number;
        cursor?: string;
        kind?: ActivityFeedFilterKind;
        extensionEvent?: ActivityExtensionEventFilter;
        tokenId?: string;
        maker?: string;
        contentHash?: string;
        eventGroup?: string;
        traitFilters?: TraitFilter[];
        traitRangeFilters?: TraitRangeFilter[];
    }): ActivityFeedPage {
        return this.listActivities({
            chainId: params.chainId,
            collectionId: params.collectionId,
            limit: params.limit,
            cursor: params.cursor,
            kind: params.kind,
            extensionEvent: params.extensionEvent,
            tokenId: params.tokenId,
            maker: params.maker,
            contentHash: params.contentHash,
            eventGroup: params.eventGroup,
            traitFilters: params.traitFilters,
            traitRangeFilters: params.traitRangeFilters,
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

    listCollectionActivityEventMedia(params: {
        chainId: number;
        collectionId: number;
        activityIds: number[];
    }): Record<string, ActivityEventMedia> {
        const activityIds = params.activityIds.filter((id) =>
            Number.isInteger(id),
        );
        if (activityIds.length === 0) return {};

        const placeholders = activityIds.map(() => "?").join(", ");
        const rows = this.apm.withSyncSpan(
            "backend.activity.db.event_media",
            {
                [ARTGOD_SPAN_ATTRIBUTE.ChainId]: params.chainId,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: params.collectionId,
                [ARTGOD_SPAN_ATTRIBUTE.ActivityActivityIdsCount]:
                    activityIds.length,
            },
            () =>
                db.raw
                    .prepare(
                        "SELECT a.id AS activity_id, m.media_ref, m.image, m.animation_url, m.html_content, m.render_modes_json " +
                            "FROM activities a " +
                            "INNER JOIN collection_extension_event_media m ON " +
                            "m.chain_id = a.chain_id AND m.collection_id = a.collection_id AND " +
                            "m.extension_key = a.source_name AND " +
                            "m.event_key = json_extract(a.payload_json, '$.eventKey') AND " +
                            "m.tx_hash = a.tx_hash AND m.log_index = a.log_index AND " +
                            "m.token_id = COALESCE(a.token_id, '') " +
                            "WHERE a.chain_id = ? AND a.collection_id = ? AND a.id IN (" +
                            placeholders +
                            ") " +
                            "ORDER BY a.id ASC, m.media_ref ASC",
                    )
                    .all(
                        params.chainId,
                        params.collectionId,
                        ...activityIds,
                    ) as ActivityEventMediaRow[],
        );
        const byActivityId: Record<string, ActivityEventMedia> = {};
        for (const row of rows) {
            const key = String(row.activity_id);
            if (byActivityId[key]) continue;
            byActivityId[key] = {
                mediaRef: row.media_ref,
                image: row.image,
                animationUrl: row.animation_url,
                htmlContent: row.html_content,
                renderModes: parseRenderModes(row.render_modes_json),
            };
        }
        return byActivityId;
    }

    private listActivities(params: {
        chainId: number;
        collectionId: number;
        tokenId?: string;
        limit: number;
        cursor?: string;
        kind?: ActivityFeedFilterKind;
        extensionEvent?: ActivityExtensionEventFilter;
        maker?: string;
        contentHash?: string;
        eventGroup?: string;
        traitFilters?: TraitFilter[];
        traitRangeFilters?: TraitRangeFilter[];
    }): ActivityFeedPage {
        const limit = normalizeLimit(params.limit);
        const filterKind = params.kind ?? null;
        const traitFilterGroups = groupTraitFilters(
            normalizeTraitFilters(params.traitFilters ?? []),
        );
        const traitRangeFilterGroups = groupTraitRangeFilters(
            normalizeTraitRangeFilters(params.traitRangeFilters ?? []),
        );
        const cursor =
            params.cursor !== undefined
                ? decodeActivityCursor(
                      params.cursor,
                      filterKind,
                      params.extensionEvent,
                  )
                : null;
        const baseSpanAttributes = buildActivityQuerySpanAttributes({
            chainId: params.chainId,
            collectionId: params.collectionId,
            filterKind,
            cursorPresent: Boolean(cursor),
            traitFilterGroups,
            traitRangeFilterGroups,
        });
        const traitTokenCandidates = resolveTraitFilterTokenCandidatesWithSpan({
            apm: this.apm,
            spanName: "backend.activity.db.trait_filter_token_candidates",
            spanAttributes: baseSpanAttributes,
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenId: params.tokenId,
            traitFilterGroups,
            traitRangeFilterGroups,
        });
        if (traitTokenCandidates.isEmpty) {
            return emptyActivityFeedPage(limit);
        }

        const spanAttributes = buildActivityQuerySpanAttributes({
            chainId: params.chainId,
            collectionId: params.collectionId,
            filterKind,
            cursorPresent: Boolean(cursor),
            traitFilterGroups,
            traitRangeFilterGroups,
            candidateTokenIdsCount:
                traitTokenCandidates.candidateTokenIdsCount,
        });

        if (
            shouldCollapseCollectionListings(
                params.tokenId,
                filterKind,
                params.extensionEvent,
                params.maker,
                params.contentHash,
                params.eventGroup,
            )
        ) {
            const {
                whereClauses: tokenCandidateWhereClauses,
                values: tokenCandidateValues,
            } = buildTokenCandidateWhereClauses({
                tokenIds: traitTokenCandidates.tokenIds,
                tokenColumnSql: "a.token_id",
            });
            return listActivitiesFromSource({
                apm: this.apm,
                source: buildCollapsedCollectionListingsSource([
                    ...tokenCandidateWhereClauses,
                ]),
                baseWhereClauses: [],
                baseValues: [
                    params.chainId,
                    params.collectionId,
                    ACTIVITY_KIND.ListingCreated,
                    ...tokenCandidateValues,
                ],
                limit,
                cursor,
                filterKind,
                spanAttributes,
            });
        }

        const { whereClauses: baseWhereClauses, values: baseValues } =
            buildActivityWhereClauses({
                chainId: params.chainId,
                collectionId: params.collectionId,
                tokenId: params.tokenId,
                tokenIds: traitTokenCandidates.tokenIds ?? undefined,
                kind: filterKind,
                extensionEvent: params.extensionEvent,
                maker: params.maker,
                contentHash: params.contentHash,
                eventGroup: params.eventGroup,
            });

        return listActivitiesFromSource({
            apm: this.apm,
            source: RAW_ACTIVITY_SOURCE,
            baseWhereClauses,
            baseValues,
            limit,
            cursor,
            filterKind,
            extensionEvent: params.extensionEvent,
            spanAttributes,
        });
    }
}

function parseRenderModes(
    value: string | null,
): ActivityEventMedia["renderModes"] {
    if (!value) return undefined;
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return undefined;
        const modes = parsed
            .map((mode) => {
                if (!mode || typeof mode !== "object") return null;
                const record = mode as Record<string, unknown>;
                if (
                    typeof record.key !== "string" ||
                    typeof record.label !== "string"
                ) {
                    return null;
                }
                return {
                    key: record.key,
                    label: record.label,
                };
            })
            .filter((mode): mode is { key: string; label: string } =>
                Boolean(mode),
            );
        return modes.length > 0 ? modes : undefined;
    } catch {
        return undefined;
    }
}

function buildActivityWhereClauses(params: {
    chainId: number;
    collectionId: number;
    tokenId?: string;
    tokenIds?: string[];
    kind: ActivityFeedFilterKind | null;
    extensionEvent?: ActivityExtensionEventFilter;
    maker?: string;
    contentHash?: string;
    eventGroup?: string;
}): {
    whereClauses: string[];
    values: unknown[];
} {
    const {
        whereClauses: tokenCandidateWhereClauses,
        values: tokenCandidateValues,
    } = buildTokenCandidateWhereClauses({
        tokenIds: params.tokenIds ?? null,
        tokenColumnSql: "token_id",
    });
    const whereClauses = [
        "chain_id = ?",
        "collection_id = ?",
        ...(params.tokenId ? ["token_id = ?"] : []),
        ...tokenCandidateWhereClauses,
    ];
    const values: unknown[] = [
        params.chainId,
        params.collectionId,
        ...(params.tokenId ? [params.tokenId] : []),
        ...tokenCandidateValues,
    ];

    if (params.extensionEvent) {
        whereClauses.push(
            "kind = ?",
            "source_kind = ?",
            "source_name = ?",
            "json_extract(payload_json, '$.eventKey') = ?",
        );
        values.push(
            ACTIVITY_KIND.Custom,
            ACTIVITY_SOURCE_KIND.Extension,
            params.extensionEvent.extensionKey.toLowerCase(),
            params.extensionEvent.eventKey,
        );
    } else {
        switch (params.kind) {
            case ACTIVITY_FEED_FILTER_KIND.Sales:
                whereClauses.push("kind = ?");
                values.push(ACTIVITY_KIND.Sale);
                break;
            case ACTIVITY_FEED_FILTER_KIND.Listings:
                whereClauses.push("kind = ?");
                values.push(ACTIVITY_KIND.ListingCreated);
                break;
            case ACTIVITY_FEED_FILTER_KIND.Transfers:
                whereClauses.push("kind = ?");
                values.push(ACTIVITY_KIND.Transfer);
                break;
        }
    }

    if (params.maker) {
        whereClauses.push("maker = ?");
        values.push(params.maker.toLowerCase());
    }

    if (params.contentHash) {
        whereClauses.push(
            "LOWER(COALESCE(json_extract(payload_json, '$.contentHash'), '')) = ?",
        );
        values.push(params.contentHash.toLowerCase());
    }

    if (params.eventGroup) {
        whereClauses.push(
            "LOWER(COALESCE(json_extract(payload_json, '$.eventGroup'), '')) = ?",
        );
        values.push(params.eventGroup.toLowerCase());
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

function emptyActivityFeedPage(limit: number): ActivityFeedPage {
    return {
        items: [],
        prevCursor: null,
        nextCursor: null,
        limit,
        totalItems: 0,
        rangeStart: 0,
        rangeEnd: 0,
        currentPage: 0,
        totalPages: 0,
    };
}

function shouldCollapseCollectionListings(
    tokenId: string | undefined,
    filterKind: ActivityFeedFilterKind | null,
    extensionEvent: ActivityExtensionEventFilter | undefined,
    maker: string | undefined,
    contentHash: string | undefined,
    eventGroup: string | undefined,
): boolean {
    return (
        !tokenId &&
        !extensionEvent &&
        !maker &&
        !contentHash &&
        !eventGroup &&
        filterKind === ACTIVITY_FEED_FILTER_KIND.Listings
    );
}

function buildCollapsedCollectionListingsSource(
    traitWhereClauses: string[],
): ActivityQuerySource {
    const traitWhereSql =
        traitWhereClauses.length === 0
            ? ""
            : ` AND ${traitWhereClauses.join(" AND ")}`;
    return {
        name: "collapsed_collection_listings",
        cteSql:
            "WITH filtered_listing_activities AS (" +
            "SELECT id, scope_kind, kind, contract_address, token_id, occurred_at, source_kind, source_name, order_id, block_number, tx_hash, log_index, from_address, to_address, maker, taker, side, amount, price, currency, payload_json, " +
            "CAST(occurred_at / 86400 AS INTEGER) AS collapsed_day_bucket " +
            "FROM activities a " +
            "WHERE a.chain_id = ? AND a.collection_id = ? AND a.kind = ?" +
            traitWhereSql +
            "), ranked_listing_activities AS (" +
            "SELECT id, scope_kind, kind, contract_address, token_id, occurred_at, source_kind, source_name, order_id, block_number, tx_hash, log_index, from_address, to_address, maker, taker, side, amount, price, currency, payload_json, " +
            "COUNT(*) OVER (PARTITION BY token_id, COALESCE(maker, ''), COALESCE(currency, ''), collapsed_day_bucket) AS collapsed_event_count, " +
            "(collapsed_day_bucket * 86400) AS collapsed_window_start_utc, " +
            "(((collapsed_day_bucket + 1) * 86400) - 1) AS collapsed_window_end_utc, " +
            "ROW_NUMBER() OVER (PARTITION BY token_id, COALESCE(maker, ''), COALESCE(currency, ''), collapsed_day_bucket ORDER BY occurred_at DESC, id DESC) AS collapse_rank " +
            "FROM filtered_listing_activities" +
            "), collapsed_listing_activities AS (" +
            "SELECT id, scope_kind, kind, contract_address, token_id, occurred_at, source_kind, source_name, order_id, block_number, tx_hash, log_index, from_address, to_address, maker, taker, side, amount, price, currency, payload_json, " +
            "1 AS is_collapsed, collapsed_event_count, collapsed_window_start_utc, collapsed_window_end_utc " +
            "FROM ranked_listing_activities WHERE collapse_rank = 1" +
            ") ",
        relationSql: "FROM collapsed_listing_activities",
        selectColumnsSql: COLLAPSED_ACTIVITY_SELECT_COLUMNS,
    };
}

function buildActivityQuerySpanAttributes(params: {
    chainId: number;
    collectionId: number;
    filterKind: ActivityFeedFilterKind | null;
    cursorPresent: boolean;
    traitFilterGroups: TraitFilterGroup[];
    traitRangeFilterGroups: TraitRangeFilterGroup[];
    candidateTokenIdsCount?: number;
}): SpanAttributes {
    const attributes: SpanAttributes = {
        [ARTGOD_SPAN_ATTRIBUTE.ChainId]: params.chainId,
        [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: params.collectionId,
        [ARTGOD_SPAN_ATTRIBUTE.ActivityKind]:
            params.filterKind ?? ARTGOD_TRACE_ATTRIBUTE_VALUE.None,
        [ARTGOD_SPAN_ATTRIBUTE.ActivityCursorPresent]:
            params.cursorPresent,
        [ARTGOD_SPAN_ATTRIBUTE.ActivityTraitsCount]:
            params.traitFilterGroups.length,
        [ARTGOD_SPAN_ATTRIBUTE.ActivityTraitRangesCount]:
            params.traitRangeFilterGroups.length,
    };
    if (params.candidateTokenIdsCount !== undefined) {
        attributes[ARTGOD_SPAN_ATTRIBUTE.ActivityCandidateTokenIdsCount] =
            params.candidateTokenIdsCount;
    }
    return attributes;
}

function listActivitiesFromSource(params: {
    apm: ApmPort;
    source: ActivityQuerySource;
    baseWhereClauses: string[];
    baseValues: unknown[];
    limit: number;
    cursor: ActivityFeedCursor | null;
    filterKind: ActivityFeedFilterKind | null;
    extensionEvent?: ActivityExtensionEventFilter;
    spanAttributes: SpanAttributes;
}): ActivityFeedPage {
    const {
        source,
        apm,
        baseWhereClauses,
        baseValues,
        limit,
        cursor,
        filterKind,
        extensionEvent,
        spanAttributes,
    } = params;
    const whereClauses = [...baseWhereClauses];
    const values: unknown[] = [...baseValues];

    if (cursor) {
        whereClauses.push(buildActivityAfterCursorWhereClause());
        values.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
    }

    const rows = queryActivityRows(
        apm,
        source,
        whereClauses,
        values,
        limit + 1,
        spanAttributes,
    );
    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapActivityRow);
    const prevCursor = deriveActivityPrevCursor({
        apm,
        source,
        baseWhereClauses,
        baseValues,
        cursor,
        pageRows,
        limit,
        filterKind,
        extensionEvent,
        spanAttributes,
    });
    const totalItems =
        !cursor && !hasNext
            ? items.length
            : countMatchingActivities(
                  apm,
                  source,
                  baseWhereClauses,
                  baseValues,
                  ARTGOD_ACTIVITY_COUNT_KIND.Total,
                  spanAttributes,
              );
    const beforeItems = cursor
        ? countMatchingActivities(
              apm,
              source,
              [...baseWhereClauses, buildActivityBeforeOrAtCursorWhereClause()],
              [...baseValues, cursor.occurredAt, cursor.occurredAt, cursor.id],
              ARTGOD_ACTIVITY_COUNT_KIND.BeforeCursor,
              spanAttributes,
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
              extensionEvent: normalizeExtensionEventForCursor(
                  params.extensionEvent,
              ),
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

function queryActivityRows(
    apm: ApmPort,
    source: ActivityQuerySource,
    whereClauses: string[],
    values: unknown[],
    limit: number,
    spanAttributes: SpanAttributes,
): ActivityRow[] {
    return apm.withSyncSpan(
        "backend.activity.db.query_rows",
        {
            ...spanAttributes,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityQuerySource]: source.name,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityLimit]: limit,
        },
        () =>
            db.raw
                .prepare(
                    `${source.cteSql}SELECT ${source.selectColumnsSql} ${source.relationSql}${buildWhereSql(whereClauses)} ORDER BY occurred_at DESC, id DESC LIMIT ?`,
                )
                .all(...values, limit) as ActivityRow[],
    );
}

function countMatchingActivities(
    apm: ApmPort,
    source: ActivityQuerySource,
    whereClauses: string[],
    values: unknown[],
    countKind:
        | typeof ARTGOD_ACTIVITY_COUNT_KIND.Total
        | typeof ARTGOD_ACTIVITY_COUNT_KIND.BeforeCursor,
    spanAttributes: SpanAttributes,
): number {
    const row = apm.withSyncSpan(
        "backend.activity.db.count",
        {
            ...spanAttributes,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityQuerySource]: source.name,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityCountKind]: countKind,
        },
        () =>
            db.raw
                .prepare(
                    `${source.cteSql}SELECT COUNT(*) AS count ${source.relationSql}${buildWhereSql(whereClauses)}`,
                )
                .get(...values) as { count: number | bigint } | undefined,
    );
    if (!row) return 0;
    return typeof row.count === "bigint" ? Number(row.count) : row.count;
}

function deriveActivityPrevCursor(params: {
    apm: ApmPort;
    source: ActivityQuerySource;
    baseWhereClauses: string[];
    baseValues: unknown[];
    cursor: ActivityFeedCursor | null;
    pageRows: ActivityRow[];
    limit: number;
    filterKind: ActivityFeedFilterKind | null;
    extensionEvent?: ActivityExtensionEventFilter;
    spanAttributes: SpanAttributes;
}): string | null {
    const {
        source,
        apm,
        baseWhereClauses,
        baseValues,
        cursor,
        pageRows,
        limit,
        filterKind,
        spanAttributes,
    } = params;
    if (!cursor) return null;

    const anchor = toAnchorCursorKey(pageRows, cursor);
    if (!anchor) return null;

    const previousRows = apm.withSyncSpan(
        "backend.activity.db.prev_cursor",
        {
            ...spanAttributes,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityQuerySource]: source.name,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityLimit]: limit + 1,
        },
        () =>
            db.raw
                .prepare(
                    `${source.cteSql}SELECT id, occurred_at ${source.relationSql}${buildWhereSql(
                        [
                            ...baseWhereClauses,
                            buildActivityBeforeCursorWhereClause(),
                        ],
                    )} ORDER BY occurred_at ASC, id ASC LIMIT ?`,
                )
                .all(
                    ...baseValues,
                    anchor.occurredAt,
                    anchor.occurredAt,
                    anchor.id,
                    limit + 1,
                ) as Array<{ id: number; occurred_at: number }>,
    );

    if (previousRows.length <= limit) {
        return null;
    }

    return encodeActivityCursor({
        filterKind,
        extensionEvent: normalizeExtensionEventForCursor(params.extensionEvent),
        occurredAt: previousRows[limit]!.occurred_at,
        id: previousRows[limit]!.id,
    });
}

function buildWhereSql(whereClauses: string[]): string {
    return whereClauses.length === 0
        ? " "
        : ` WHERE ${whereClauses.join(" AND ")} `;
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
    expectedExtensionEvent: ActivityExtensionEventFilter | undefined,
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
        const cursorExtensionEvent = normalizeCursorExtensionEvent(
            decoded.extensionEvent,
        );
        if (cursorFilterKind !== expectedFilterKind) {
            throw new Error("Cursor filter mismatch");
        }
        if (
            !sameExtensionEvent(
                cursorExtensionEvent,
                normalizeExtensionEventForCursor(expectedExtensionEvent),
            )
        ) {
            throw new Error("Cursor extension event mismatch");
        }
        return {
            occurredAt: decoded.occurredAt,
            id: decoded.id,
            filterKind: cursorFilterKind,
            extensionEvent: cursorExtensionEvent,
        };
    } catch {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
}

function normalizeFilterKind(
    value: ActivityFeedFilterKind | null | undefined,
): ActivityFeedFilterKind | null {
    return value === ACTIVITY_FEED_FILTER_KIND.Sales ||
        value === ACTIVITY_FEED_FILTER_KIND.Listings ||
        value === ACTIVITY_FEED_FILTER_KIND.Transfers
        ? value
        : null;
}

function normalizeExtensionEventForCursor(
    value: ActivityExtensionEventFilter | undefined,
): ActivityFeedCursor["extensionEvent"] {
    if (!value) return null;
    return {
        extensionKey: value.extensionKey.toLowerCase(),
        eventKey: value.eventKey,
    };
}

function normalizeCursorExtensionEvent(
    value: ActivityFeedCursor["extensionEvent"] | undefined,
): ActivityFeedCursor["extensionEvent"] {
    if (
        !value ||
        typeof value.extensionKey !== "string" ||
        typeof value.eventKey !== "string"
    ) {
        return null;
    }
    return {
        extensionKey: value.extensionKey.toLowerCase(),
        eventKey: value.eventKey,
    };
}

function sameExtensionEvent(
    left: ActivityFeedCursor["extensionEvent"],
    right: ActivityFeedCursor["extensionEvent"],
): boolean {
    return (
        left?.extensionKey === right?.extensionKey &&
        left?.eventKey === right?.eventKey
    );
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
        isCollapsed: row.is_collapsed === 1,
        collapsedEventCount: row.collapsed_event_count ?? null,
        collapsedWindowStartUtc: row.collapsed_window_start_utc ?? null,
        collapsedWindowEndUtc: row.collapsed_window_end_utc ?? null,
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
