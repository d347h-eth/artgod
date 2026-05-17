import { db } from "../database/db.js";
import type {
    ApmPort,
    SpanAttributes,
} from "../observability/apm.js";
import type { TraitFilter, TraitRangeFilter } from "../types/browse.js";
import { ReadModelBadRequestError } from "./errors.js";

export type TraitFilterGroup = {
    key: string;
    values: string[];
};

export type TraitRangeFilterGroup = {
    key: string;
    fromValue: string | null;
    toValue: string | null;
};

type TokenIdRow = {
    token_id: string;
};

export type TraitFilterTokenCandidates = {
    tokenIds: string[] | null;
    isEmpty: boolean;
    candidateTokenIdsCount?: number;
};

export function normalizeTraitFilters(filters: TraitFilter[]): TraitFilter[] {
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

export function normalizeTraitRangeFilters(
    filters: TraitRangeFilter[],
): TraitRangeFilter[] {
    const normalized: TraitRangeFilter[] = [];
    const seen = new Set<string>();

    for (const filter of filters) {
        const key = filter.key.trim();
        const fromValue = filter.fromValue?.trim() || null;
        const toValue = filter.toValue?.trim() || null;
        if (!key || (fromValue === null && toValue === null)) {
            throw new ReadModelBadRequestError("Invalid trait range filter");
        }
        if (fromValue !== null && !/^\d+$/.test(fromValue)) {
            throw new ReadModelBadRequestError("Invalid trait range filter");
        }
        if (toValue !== null && !/^\d+$/.test(toValue)) {
            throw new ReadModelBadRequestError("Invalid trait range filter");
        }
        if (
            fromValue !== null &&
            toValue !== null &&
            BigInt(fromValue) > BigInt(toValue)
        ) {
            throw new ReadModelBadRequestError("Invalid trait range filter");
        }
        if (seen.has(key)) {
            throw new ReadModelBadRequestError("Duplicate trait range filter");
        }
        seen.add(key);
        normalized.push({
            key,
            fromValue,
            toValue,
        });
    }

    return normalized;
}

export function groupTraitFilters(filters: TraitFilter[]): TraitFilterGroup[] {
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

export function groupTraitRangeFilters(
    filters: TraitRangeFilter[],
): TraitRangeFilterGroup[] {
    return filters.map((filter) => ({
        key: filter.key,
        fromValue: filter.fromValue,
        toValue: filter.toValue,
    }));
}

export function buildTokenTraitRangeJoinClauses(params: {
    traitRangeFilterGroups: TraitRangeFilterGroup[];
    tokenColumnSql: string;
    chainId: number;
    collectionId: number;
}): {
    joinClauses: string[];
    values: unknown[];
} {
    const joinClauses: string[] = [];
    const values: unknown[] = [];

    for (const [index, filterGroup] of params.traitRangeFilterGroups.entries()) {
        const alias = `trait_range_tokens_${index}`;
        const numericComparisons: string[] = [
            "a.value <> ''",
            "a.value NOT GLOB '*[^0-9]*'",
        ];

        if (filterGroup.fromValue !== null) {
            numericComparisons.push(
                "CAST(a.value AS INTEGER) >= CAST(? AS INTEGER)",
            );
        }
        if (filterGroup.toValue !== null) {
            numericComparisons.push(
                "CAST(a.value AS INTEGER) <= CAST(? AS INTEGER)",
            );
        }

        joinClauses.push(
            "JOIN (" +
                "SELECT DISTINCT ta.token_id " +
                "FROM token_attributes ta " +
                "JOIN attributes a ON a.id = ta.attribute_id " +
                "AND a.chain_id = ta.chain_id " +
                "AND a.collection_id = ta.collection_id " +
                "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
                "AND ak.chain_id = a.chain_id " +
                "AND ak.collection_id = a.collection_id " +
                "WHERE ta.chain_id = ? " +
                "AND ta.collection_id = ? " +
                "AND ak.key = ? " +
                `AND ${numericComparisons.join(" AND ")} ` +
                `) ${alias} ON ${alias}.token_id = ${params.tokenColumnSql}`,
        );

        values.push(params.chainId, params.collectionId, filterGroup.key);
        if (filterGroup.fromValue !== null) {
            values.push(filterGroup.fromValue);
        }
        if (filterGroup.toValue !== null) {
            values.push(filterGroup.toValue);
        }
    }

    return {
        joinClauses,
        values,
    };
}

// Resolves trait filters once so callers can avoid correlated trait checks.
export function resolveTraitFilterTokenCandidatesWithSpan(params: {
    apm: ApmPort;
    spanName: string;
    spanAttributes: SpanAttributes;
    chainId: number;
    collectionId: number;
    tokenId?: string;
    traitFilterGroups: TraitFilterGroup[];
    traitRangeFilterGroups: TraitRangeFilterGroup[];
}): TraitFilterTokenCandidates {
    if (
        params.traitFilterGroups.length === 0 &&
        params.traitRangeFilterGroups.length === 0
    ) {
        return {
            tokenIds: null,
            isEmpty: false,
        };
    }

    return params.apm.withSyncSpan(
        params.spanName,
        params.spanAttributes,
        () =>
            resolveTraitFilterTokenCandidates({
                chainId: params.chainId,
                collectionId: params.collectionId,
                tokenId: params.tokenId,
                traitFilterGroups: params.traitFilterGroups,
                traitRangeFilterGroups: params.traitRangeFilterGroups,
            }),
    );
}

export function buildTokenCandidateWhereClauses(params: {
    tokenIds: string[] | null;
    tokenColumnSql: string;
}): {
    whereClauses: string[];
    values: unknown[];
} {
    if (params.tokenIds === null) {
        return { whereClauses: [], values: [] };
    }
    if (params.tokenIds.length === 0) {
        return { whereClauses: ["1 = 0"], values: [] };
    }

    return {
        whereClauses: [
            `${params.tokenColumnSql} IN (${params.tokenIds
                .map(() => "?")
                .join(", ")})`,
        ],
        values: params.tokenIds,
    };
}

function resolveTraitFilterTokenCandidates(params: {
    chainId: number;
    collectionId: number;
    tokenId?: string;
    traitFilterGroups: TraitFilterGroup[];
    traitRangeFilterGroups: TraitRangeFilterGroup[];
}): TraitFilterTokenCandidates {
    const candidateSets: string[][] = [];

    if (params.traitFilterGroups.length > 0) {
        candidateSets.push(
            listExactTraitFilterTokenIds({
                chainId: params.chainId,
                collectionId: params.collectionId,
                tokenId: params.tokenId,
                traitFilterGroups: params.traitFilterGroups,
            }),
        );
    }

    if (params.traitRangeFilterGroups.length > 0) {
        candidateSets.push(
            listTraitRangeFilterTokenIds({
                chainId: params.chainId,
                collectionId: params.collectionId,
                tokenId: params.tokenId,
                traitRangeFilterGroups: params.traitRangeFilterGroups,
            }),
        );
    }

    if (candidateSets.length === 0) {
        return {
            tokenIds: null,
            isEmpty: false,
        };
    }

    const tokenIds = intersectTokenIdSets(candidateSets);
    return {
        tokenIds,
        isEmpty: tokenIds.length === 0,
        candidateTokenIdsCount: tokenIds.length,
    };
}

function listExactTraitFilterTokenIds(params: {
    chainId: number;
    collectionId: number;
    tokenId?: string;
    traitFilterGroups: TraitFilterGroup[];
}): string[] {
    if (params.traitFilterGroups.length === 0) {
        return [];
    }

    const traitClauses: string[] = [];
    const values: unknown[] = [params.chainId, params.collectionId];
    for (const filterGroup of params.traitFilterGroups) {
        const valuePlaceholders = filterGroup.values.map(() => "?").join(", ");
        traitClauses.push(
            `(ak.key = ? AND a.value IN (${valuePlaceholders}))`,
        );
        values.push(filterGroup.key, ...filterGroup.values);
    }
    values.push(
        params.chainId,
        params.collectionId,
        ...(params.tokenId ? [params.tokenId] : []),
        params.traitFilterGroups.length,
    );

    const rows = db.raw
        .prepare(
            "WITH matching_attributes AS (" +
                "SELECT ak.key, a.id AS attribute_id " +
                "FROM attribute_keys ak " +
                "JOIN attributes a ON a.attribute_key_id = ak.id " +
                "AND a.chain_id = ak.chain_id " +
                "AND a.collection_id = ak.collection_id " +
                "WHERE ak.chain_id = ? " +
                "AND ak.collection_id = ? " +
                `AND (${traitClauses.join(" OR ")})` +
                ") " +
                "SELECT ta.token_id " +
                "FROM matching_attributes ma " +
                "JOIN token_attributes ta ON ta.attribute_id = ma.attribute_id " +
                "WHERE ta.chain_id = ? " +
                "AND ta.collection_id = ? " +
                (params.tokenId ? "AND ta.token_id = ? " : "") +
                "GROUP BY ta.token_id " +
                "HAVING COUNT(DISTINCT ma.key) = ? " +
                "ORDER BY ta.token_id",
        )
        .all(...values) as TokenIdRow[];
    return rows.map((row) => row.token_id);
}

function listTraitRangeFilterTokenIds(params: {
    chainId: number;
    collectionId: number;
    tokenId?: string;
    traitRangeFilterGroups: TraitRangeFilterGroup[];
}): string[] {
    if (params.traitRangeFilterGroups.length === 0) {
        return [];
    }

    const rangeClauses: string[] = [];
    const values: unknown[] = [params.chainId, params.collectionId];
    for (const filterGroup of params.traitRangeFilterGroups) {
        const numericComparisons: string[] = [
            "a.value <> ''",
            "a.value NOT GLOB '*[^0-9]*'",
        ];

        if (filterGroup.fromValue !== null) {
            numericComparisons.push(
                "CAST(a.value AS INTEGER) >= CAST(? AS INTEGER)",
            );
        }
        if (filterGroup.toValue !== null) {
            numericComparisons.push(
                "CAST(a.value AS INTEGER) <= CAST(? AS INTEGER)",
            );
        }

        rangeClauses.push(
            `(ak.key = ? AND ${numericComparisons.join(" AND ")})`,
        );
        values.push(filterGroup.key);
        if (filterGroup.fromValue !== null) {
            values.push(filterGroup.fromValue);
        }
        if (filterGroup.toValue !== null) {
            values.push(filterGroup.toValue);
        }
    }
    values.push(
        params.chainId,
        params.collectionId,
        ...(params.tokenId ? [params.tokenId] : []),
        params.traitRangeFilterGroups.length,
    );

    const rows = db.raw
        .prepare(
            "WITH matching_ranges AS (" +
                "SELECT ak.key, a.id AS attribute_id " +
                "FROM attribute_keys ak " +
                "JOIN attributes a ON a.attribute_key_id = ak.id " +
                "AND a.chain_id = ak.chain_id " +
                "AND a.collection_id = ak.collection_id " +
                "WHERE ak.chain_id = ? " +
                "AND ak.collection_id = ? " +
                `AND (${rangeClauses.join(" OR ")})` +
                ") " +
                "SELECT ta.token_id " +
                "FROM matching_ranges mr " +
                "JOIN token_attributes ta ON ta.attribute_id = mr.attribute_id " +
                "WHERE ta.chain_id = ? " +
                "AND ta.collection_id = ? " +
                (params.tokenId ? "AND ta.token_id = ? " : "") +
                "GROUP BY ta.token_id " +
                "HAVING COUNT(DISTINCT mr.key) = ? " +
                "ORDER BY ta.token_id",
        )
        .all(...values) as TokenIdRow[];
    return rows.map((row) => row.token_id);
}

function intersectTokenIdSets(candidateSets: string[][]): string[] {
    const [firstSet, ...remainingSets] = candidateSets
        .slice()
        .sort((left, right) => left.length - right.length);
    if (!firstSet) return [];

    let tokenIds = firstSet;
    for (const candidateSet of remainingSets) {
        const allowed = new Set(candidateSet);
        tokenIds = tokenIds.filter((tokenId) => allowed.has(tokenId));
        if (tokenIds.length === 0) return [];
    }

    return tokenIds;
}
