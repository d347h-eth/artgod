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

export function buildTokenTraitFilterWhereClauses(params: {
    traitFilterGroups: TraitFilterGroup[];
    chainColumnSql: string;
    collectionColumnSql: string;
    tokenColumnSql: string;
}): {
    whereClauses: string[];
    values: unknown[];
} {
    const whereClauses: string[] = [];
    const values: unknown[] = [];

    for (const filterGroup of params.traitFilterGroups) {
        const valuePlaceholders = filterGroup.values.map(() => "?").join(", ");
        whereClauses.push(
            "EXISTS (" +
                "SELECT 1 " +
                "FROM token_attributes ta " +
                "JOIN attributes a ON a.id = ta.attribute_id " +
                "AND a.chain_id = ta.chain_id " +
                "AND a.collection_id = ta.collection_id " +
                "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
                "AND ak.chain_id = a.chain_id " +
                "AND ak.collection_id = a.collection_id " +
                `WHERE ta.chain_id = ${params.chainColumnSql} ` +
                `AND ta.collection_id = ${params.collectionColumnSql} ` +
                `AND ta.token_id = ${params.tokenColumnSql} ` +
                "AND ak.key = ? " +
                `AND a.value IN (${valuePlaceholders}) ` +
                ")",
        );
        values.push(filterGroup.key, ...filterGroup.values);
    }

    return {
        whereClauses,
        values,
    };
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
            numericComparisons.push("CAST(a.value AS INTEGER) >= CAST(? AS INTEGER)");
        }
        if (filterGroup.toValue !== null) {
            numericComparisons.push("CAST(a.value AS INTEGER) <= CAST(? AS INTEGER)");
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

export function buildTokenTraitRangeWhereClauses(params: {
    traitRangeFilterGroups: TraitRangeFilterGroup[];
    chainColumnSql: string;
    collectionColumnSql: string;
    tokenColumnSql: string;
}): {
    whereClauses: string[];
    values: unknown[];
} {
    const whereClauses: string[] = [];
    const values: unknown[] = [];

    for (const filterGroup of params.traitRangeFilterGroups) {
        const numericComparisons: string[] = [
            "a.value <> ''",
            "a.value NOT GLOB '*[^0-9]*'",
        ];

        if (filterGroup.fromValue !== null) {
            numericComparisons.push("CAST(a.value AS INTEGER) >= CAST(? AS INTEGER)");
        }
        if (filterGroup.toValue !== null) {
            numericComparisons.push("CAST(a.value AS INTEGER) <= CAST(? AS INTEGER)");
        }

        whereClauses.push(
            "EXISTS (" +
                "SELECT 1 " +
                "FROM token_attributes ta " +
                "JOIN attributes a ON a.id = ta.attribute_id " +
                "AND a.chain_id = ta.chain_id " +
                "AND a.collection_id = ta.collection_id " +
                "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
                "AND ak.chain_id = a.chain_id " +
                "AND ak.collection_id = a.collection_id " +
                `WHERE ta.chain_id = ${params.chainColumnSql} ` +
                `AND ta.collection_id = ${params.collectionColumnSql} ` +
                `AND ta.token_id = ${params.tokenColumnSql} ` +
                "AND ak.key = ? " +
                `AND ${numericComparisons.join(" AND ")} ` +
                ")",
        );

        values.push(filterGroup.key);
        if (filterGroup.fromValue !== null) {
            values.push(filterGroup.fromValue);
        }
        if (filterGroup.toValue !== null) {
            values.push(filterGroup.toValue);
        }
    }

    return {
        whereClauses,
        values,
    };
}
