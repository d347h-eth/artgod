import { db } from "../database/db.js";
import { MAX_PAGE_LIMIT } from "../config/pagination.js";
import type {
    CollectionListCursor,
    CollectionListItem,
    CursorPage,
    TokenCard,
    TokenCursorPage,
    TokenCursor,
    TokenAttribute,
    TraitFacet,
    TraitFilter,
} from "../types/browse.js";
import { decodeOpaqueCursor, encodeOpaqueCursor } from "../utils/cursor.js";
import {
    isAddressRef,
    isSlugRef,
    normalizeAddressRef,
    normalizeSlugRef,
} from "../utils/ref-resolver.js";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "./errors.js";

type CollectionRow = {
    chain_id: number;
    collection_id: string;
    slug: string | null;
    address: string;
    standard: string;
    status: string;
    deployment_block: number | null;
    bootstrap_anchor_block: number | null;
    created_at: string;
    updated_at: string;
};

type TokenRow = {
    token_id: string;
    name: string | null;
    image: string | null;
    attributes_json: string | null;
    metadata_updated_at: string | null;
};

type TokenIdRow = {
    token_id: string;
};

type TraitFacetRow = {
    key: string;
    value: string;
    token_count: number;
};

type TokenSortKey = {
    tokenId: string;
    bucket: number;
    length: number;
    value: string;
};

const TOKEN_ID_IS_NUMERIC_SQL =
    "t.token_id <> '' AND t.token_id NOT GLOB '*[^0-9]*'";
const TOKEN_ID_NORMALIZED_NUMERIC_SQL =
    "CASE WHEN LTRIM(t.token_id, '0') = '' THEN '0' ELSE LTRIM(t.token_id, '0') END";
const TOKEN_SORT_BUCKET_SQL = `CASE WHEN ${TOKEN_ID_IS_NUMERIC_SQL} THEN 0 ELSE 1 END`;
const TOKEN_SORT_LENGTH_SQL = `CASE WHEN ${TOKEN_ID_IS_NUMERIC_SQL} THEN LENGTH(${TOKEN_ID_NORMALIZED_NUMERIC_SQL}) ELSE 0 END`;
const TOKEN_SORT_VALUE_SQL = `CASE WHEN ${TOKEN_ID_IS_NUMERIC_SQL} THEN ${TOKEN_ID_NORMALIZED_NUMERIC_SQL} ELSE t.token_id END`;
const TOKEN_SORT_KEY_SQL = `(${TOKEN_SORT_BUCKET_SQL}, ${TOKEN_SORT_LENGTH_SQL}, ${TOKEN_SORT_VALUE_SQL}, t.token_id)`;
const TOKEN_ORDER_BY_ASC_SQL = `${TOKEN_SORT_BUCKET_SQL} ASC, ${TOKEN_SORT_LENGTH_SQL} ASC, ${TOKEN_SORT_VALUE_SQL} ASC, t.token_id ASC`;
const TOKEN_ORDER_BY_DESC_SQL = `${TOKEN_SORT_BUCKET_SQL} DESC, ${TOKEN_SORT_LENGTH_SQL} DESC, ${TOKEN_SORT_VALUE_SQL} DESC, t.token_id DESC`;

export type ListCollectionsParams = {
    chainId: number;
    status?: "bootstrapping" | "live" | "paused" | "disabled";
    limit: number;
    cursor?: string;
};

export type ListCollectionTokensParams = {
    chainId: number;
    contractAddress: string;
    limit: number;
    cursor?: string;
    traitFilters?: TraitFilter[];
};

export class SqliteCollectionsReadModel {
    private selectCollectionBySlug = db.prepare<{ chainId: number; slug: string }>(
        "SELECT chain_id, collection_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, created_at, updated_at " +
            "FROM collections " +
            "WHERE chain_id = @chainId AND slug = @slug " +
            "LIMIT 1",
    );

    private selectCollectionByAddress = db.prepare<{
        chainId: number;
        address: string;
    }>(
        "SELECT chain_id, collection_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, created_at, updated_at " +
            "FROM collections " +
            "WHERE chain_id = @chainId AND lower(address) = @address " +
            "LIMIT 1",
    );

    private selectTraitFacetRows = db.prepare<[number, string]>(
        "SELECT attribute_keys.key as key, attributes.value as value, collection_trait_stats.token_count as token_count " +
            "FROM collection_trait_stats " +
            "JOIN attributes ON attributes.id = collection_trait_stats.attribute_id " +
            "AND attributes.chain_id = collection_trait_stats.chain_id " +
            "AND attributes.contract_address = collection_trait_stats.contract_address " +
            "JOIN attribute_keys ON attribute_keys.id = collection_trait_stats.attribute_key_id " +
            "AND attribute_keys.chain_id = collection_trait_stats.chain_id " +
            "AND attribute_keys.contract_address = collection_trait_stats.contract_address " +
            "WHERE collection_trait_stats.chain_id = ? AND collection_trait_stats.contract_address = ? " +
            "ORDER BY attribute_keys.key ASC, collection_trait_stats.token_count ASC, attributes.value ASC",
    );

    listCollections(
        params: ListCollectionsParams,
    ): CursorPage<CollectionListItem> {
        const limit = normalizeLimit(params.limit);
        const cursor =
            params.cursor !== undefined
                ? decodeCollectionCursor(params.cursor)
                : null;

        const whereClauses: string[] = ["chain_id = ?"];
        const values: unknown[] = [params.chainId];

        if (params.status) {
            whereClauses.push("status = ?");
            values.push(params.status);
        }

        if (cursor) {
            whereClauses.push(
                "(created_at < ? OR (created_at = ? AND address > ?))",
            );
            values.push(cursor.createdAt, cursor.createdAt, cursor.address);
        }

        const sql =
            "SELECT chain_id, collection_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, created_at, updated_at " +
            "FROM collections " +
            `WHERE ${whereClauses.join(" AND ")} ` +
            "ORDER BY created_at DESC, address ASC " +
            "LIMIT ?";

        values.push(limit + 1);

        const rows = db.raw.prepare(sql).all(...values) as CollectionRow[];
        const hasNext = rows.length > limit;
        const pageRows = hasNext ? rows.slice(0, limit) : rows;
        const items = pageRows.map(mapCollectionRow);

        const nextCursor = hasNext
            ? encodeOpaqueCursor({
                  createdAt: pageRows[pageRows.length - 1]!.created_at,
                  address: pageRows[pageRows.length - 1]!.address.toLowerCase(),
              })
            : null;

        return {
            items,
            nextCursor,
            limit,
        };
    }

    resolveCollectionRef(
        chainId: number,
        collectionRef: string,
    ): CollectionListItem {
        const ref = collectionRef.trim();
        let row: CollectionRow | undefined;

        if (isAddressRef(ref)) {
            row = this.selectCollectionByAddress.get({
                chainId,
                address: normalizeAddressRef(ref),
            }) as CollectionRow | undefined;
        } else if (isSlugRef(ref)) {
            row = this.selectCollectionBySlug.get({
                chainId,
                slug: normalizeSlugRef(ref),
            }) as CollectionRow | undefined;
        } else {
            throw new ReadModelBadRequestError("Invalid collection_ref");
        }

        if (!row) {
            throw new ReadModelNotFoundError("Unknown collection_ref");
        }

        return mapCollectionRow(row);
    }

    listCollectionTokens(
        params: ListCollectionTokensParams,
    ): TokenCursorPage {
        const limit = normalizeLimit(params.limit);
        const cursor =
            params.cursor !== undefined ? decodeTokenCursor(params.cursor) : null;
        const cursorSortKey = cursor ? toTokenSortKey(cursor.tokenId) : null;
        const contractAddress = normalizeAddressRef(params.contractAddress);
        const traitFilterGroups = groupTraitFilters(
            normalizeTraitFilters(params.traitFilters ?? []),
        );

        const baseWhereClauses: string[] = [
            "t.chain_id = ?",
            "t.contract_address = ?",
        ];
        const baseValues: unknown[] = [params.chainId, contractAddress];

        for (const filterGroup of traitFilterGroups) {
            const valuePlaceholders = filterGroup.values
                .map(() => "?")
                .join(", ");
            baseWhereClauses.push(
                "EXISTS (" +
                    "SELECT 1 " +
                    "FROM token_attributes ta " +
                    "JOIN attributes a ON a.id = ta.attribute_id " +
                    "AND a.chain_id = ta.chain_id " +
                    "AND a.contract_address = ta.contract_address " +
                    "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
                    "AND ak.chain_id = a.chain_id " +
                    "AND ak.contract_address = a.contract_address " +
                    "WHERE ta.chain_id = t.chain_id " +
                    "AND ta.contract_address = t.contract_address " +
                    "AND ta.token_id = t.token_id " +
                    "AND ak.key = ? " +
                    `AND a.value IN (${valuePlaceholders}) ` +
                    ")",
            );
            baseValues.push(filterGroup.key, ...filterGroup.values);
        }

        const whereClauses = [...baseWhereClauses];
        const values = [...baseValues];
        if (cursorSortKey) {
            whereClauses.push(`${TOKEN_SORT_KEY_SQL} > (?, ?, ?, ?)`);
            values.push(...tokenSortKeyParams(cursorSortKey));
        }

        const sql =
            "SELECT t.token_id, m.name, m.image, m.attributes_json, m.updated_at AS metadata_updated_at " +
            "FROM tokens t " +
            "LEFT JOIN token_metadata m ON m.chain_id = t.chain_id " +
            "AND m.contract_address = t.contract_address " +
            "AND m.token_id = t.token_id " +
            `WHERE ${whereClauses.join(" AND ")} ` +
            `ORDER BY ${TOKEN_ORDER_BY_ASC_SQL} ` +
            "LIMIT ?";

        values.push(limit + 1);

        const rows = db.raw.prepare(sql).all(...values) as TokenRow[];
        const hasNext = rows.length > limit;
        const pageRows = hasNext ? rows.slice(0, limit) : rows;
        const items = pageRows.map(mapTokenRow);

        const prevCursor = derivePrevCursor({
            baseWhereClauses,
            baseValues,
            cursor,
            pageRows,
            limit,
        });

        const totalItems = countMatchingTokens(baseWhereClauses, baseValues);
        const beforeItems = cursorSortKey
            ? countMatchingTokens(
                  [...baseWhereClauses, `${TOKEN_SORT_KEY_SQL} <= (?, ?, ?, ?)`],
                  [...baseValues, ...tokenSortKeyParams(cursorSortKey)],
              )
            : 0;
        const rangeStart = items.length === 0 ? 0 : beforeItems + 1;
        const rangeEnd = beforeItems + items.length;
        const totalPages =
            totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
        const currentPage =
            totalItems === 0 ? 0 : Math.floor(beforeItems / limit) + 1;

        const nextCursor = hasNext
            ? encodeOpaqueCursor({
                  tokenId: pageRows[pageRows.length - 1]!.token_id,
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

    listCollectionTraitFacets(chainId: number, contractAddress: string): TraitFacet[] {
        const rows = this.selectTraitFacetRows.all(
            chainId,
            normalizeAddressRef(contractAddress),
        ) as TraitFacetRow[];

        const facets: TraitFacet[] = [];
        const byKey = new Map<string, TraitFacet>();
        for (const row of rows) {
            let facet = byKey.get(row.key);
            if (!facet) {
                facet = { key: row.key, values: [] };
                byKey.set(row.key, facet);
                facets.push(facet);
            }
            facet.values.push({
                value: row.value,
                tokenCount: row.token_count,
            });
        }
        return facets;
    }
}

function countMatchingTokens(whereClauses: string[], values: unknown[]): number {
    const sql =
        "SELECT COUNT(*) AS count " +
        "FROM tokens t " +
        `WHERE ${whereClauses.join(" AND ")}`;
    const row = db.raw.prepare(sql).get(...values) as { count: number };
    return row.count;
}

function derivePrevCursor(params: {
    baseWhereClauses: string[];
    baseValues: unknown[];
    cursor: TokenCursor | null;
    pageRows: TokenRow[];
    limit: number;
}): string | null {
    const { baseWhereClauses, baseValues, cursor, pageRows, limit } = params;

    const anchorTokenId = pageRows[0]?.token_id ?? cursor?.tokenId ?? null;
    if (!anchorTokenId) {
        return null;
    }
    const anchorSortKey = toTokenSortKey(anchorTokenId);

    const previousRows = db.raw
        .prepare(
            "SELECT t.token_id " +
                "FROM tokens t " +
                `WHERE ${baseWhereClauses.join(" AND ")} AND ${TOKEN_SORT_KEY_SQL} < (?, ?, ?, ?) ` +
                `ORDER BY ${TOKEN_ORDER_BY_DESC_SQL} ` +
                "LIMIT ?",
        )
        .all(...baseValues, ...tokenSortKeyParams(anchorSortKey), limit + 1) as TokenIdRow[];

    if (previousRows.length <= limit) {
        return null;
    }

    return encodeOpaqueCursor({
        tokenId: previousRows[limit]!.token_id,
    });
}

function normalizeLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new ReadModelBadRequestError("Invalid limit");
    }
    return Math.min(limit, MAX_PAGE_LIMIT);
}

function decodeCollectionCursor(cursor: string): CollectionListCursor {
    try {
        const decoded = decodeOpaqueCursor<CollectionListCursor>(cursor);
        if (
            !decoded ||
            typeof decoded.createdAt !== "string" ||
            typeof decoded.address !== "string"
        ) {
            throw new Error("bad payload");
        }
        return {
            createdAt: decoded.createdAt,
            address: decoded.address.toLowerCase(),
        };
    } catch {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
}

function decodeTokenCursor(cursor: string): TokenCursor {
    try {
        const decoded = decodeOpaqueCursor<TokenCursor>(cursor);
        if (!decoded || typeof decoded.tokenId !== "string") {
            throw new Error("bad payload");
        }
        return decoded;
    } catch {
        throw new ReadModelBadRequestError("Invalid cursor");
    }
}

function toTokenSortKey(tokenId: string): TokenSortKey {
    const isNumeric = /^\d+$/.test(tokenId);
    if (!isNumeric) {
        return {
            tokenId,
            bucket: 1,
            length: 0,
            value: tokenId,
        };
    }

    const withoutLeadingZeros = tokenId.replace(/^0+/, "");
    const normalized = withoutLeadingZeros.length > 0 ? withoutLeadingZeros : "0";
    return {
        tokenId,
        bucket: 0,
        length: normalized.length,
        value: normalized,
    };
}

function tokenSortKeyParams(key: TokenSortKey): [number, number, string, string] {
    return [key.bucket, key.length, key.value, key.tokenId];
}

function normalizeTraitFilters(filters: TraitFilter[]): TraitFilter[] {
    const deduped: TraitFilter[] = [];
    const seen = new Set<string>();

    for (const filter of filters) {
        const key = filter.key.trim();
        const value = filter.value.trim();
        if (!key || !value) {
            throw new ReadModelBadRequestError("Invalid trait filter");
        }
        const signature = `${key}:${value}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        deduped.push({ key, value });
    }

    return deduped;
}

type TraitFilterGroup = {
    key: string;
    values: string[];
};

function groupTraitFilters(filters: TraitFilter[]): TraitFilterGroup[] {
    const grouped = new Map<string, Set<string>>();
    for (const filter of filters) {
        const values = grouped.get(filter.key) ?? new Set<string>();
        values.add(filter.value);
        grouped.set(filter.key, values);
    }

    const groups: TraitFilterGroup[] = [];
    for (const [key, values] of grouped.entries()) {
        groups.push({
            key,
            values: [...values],
        });
    }
    return groups;
}

function mapCollectionRow(row: CollectionRow): CollectionListItem {
    return {
        chainId: row.chain_id,
        collectionId: row.collection_id,
        slug: row.slug,
        address: row.address.toLowerCase(),
        standard: row.standard as CollectionListItem["standard"],
        status: row.status as CollectionListItem["status"],
        deploymentBlock: row.deployment_block,
        bootstrapAnchorBlock: row.bootstrap_anchor_block,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapTokenRow(row: TokenRow): TokenCard {
    return {
        tokenId: row.token_id,
        name: row.name ?? null,
        image: row.image ?? null,
        attributes: parseTokenAttributes(row.attributes_json),
        hasMetadata: row.metadata_updated_at !== null,
        metadataUpdatedAt: row.metadata_updated_at,
    };
}

function parseTokenAttributes(raw: string | null): TokenAttribute[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        const normalized: TokenAttribute[] = [];
        for (const entry of parsed) {
            if (!entry || typeof entry !== "object") continue;
            const source = entry as { traitType?: unknown; value?: unknown };
            if (typeof source.traitType !== "string") continue;
            if (source.value === undefined || source.value === null) continue;
            const key = source.traitType.trim();
            const value = String(source.value).trim();
            if (!key || !value) continue;
            normalized.push({ key, value });
        }
        return normalized;
    } catch {
        return [];
    }
}
