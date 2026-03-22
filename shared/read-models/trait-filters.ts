import type { TraitFilter } from "../types/browse.js";
import { ReadModelBadRequestError } from "./errors.js";

export type TraitFilterGroup = {
    key: string;
    values: string[];
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
