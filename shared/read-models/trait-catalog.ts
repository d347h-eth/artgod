import { db } from "../database/db.js";
import { CANONICAL_TRAIT_RELATION_SQL } from "../database/canonical-traits.js";
import { getTraitCatalogRebuild } from "../database/trait-catalog-rebuilds.js";
import type {
    TokenDetailTrait,
    TraitFilter,
    TraitFacet,
} from "../types/browse.js";
import { TRAIT_FILTER_DISPLAY_KIND } from "../types/customization.js";
import {
    TRAIT_CATALOG,
    type CollectionViewDescriptor,
    type CollectionViewStatus,
    type TraitCatalogMapper,
    type TraitReadContext,
    type TraitNode,
} from "../types/trait-catalog.js";
import type {
    TraitFilterGroup,
    TraitRangeFilterGroup,
} from "./trait-filters.js";
import { ReadModelBadRequestError, ReadModelNotFoundError } from "./errors.js";
export { readCanonicalTokenTraits } from "../database/canonical-traits.js";

type Scope = {
    chainId: number;
    collectionId: number;
    traitContext: TraitReadContext;
};
type Sql = { sql: string; values: (string | number)[] };

export function readTokenViewId(
    chainId: number,
    collectionId: number,
    tokenId: string,
): string | null {
    return (
        (db.raw
            .prepare(
                "SELECT view_id FROM trait_catalog_members WHERE chain_id=? AND collection_id=? AND token_id=?",
            )
            .pluck()
            .get(chainId, collectionId, tokenId) as string) ?? null
    );
}

export function readViewStatus(
    chainId: number,
    collectionId: number,
    mapper: TraitCatalogMapper,
    viewId?: string,
): CollectionViewStatus[] {
    const bindScope =
        viewId === undefined
            ? [chainId, collectionId]
            : [chainId, collectionId, viewId];
    return db.raw.transaction(() => {
        const rows = db.raw
            .prepare(
                `SELECT descriptor_json,active_generation,mapper_version,
            COALESCE(m.classified,0) classified,m.scope_key,
            COALESCE(m.errors,0)+(SELECT COUNT(*) FROM trait_catalog_work w WHERE w.generation=v.active_generation AND w.error IS NOT NULL) failed,
            (SELECT COUNT(*) FROM trait_catalog_projections p WHERE p.chain_id=v.chain_id AND p.collection_id=v.collection_id AND p.view_id=v.view_id AND p.generation=v.active_generation) ready,
            (SELECT MAX(generation) FROM trait_catalog_rebuilds r WHERE r.chain_id=v.chain_id AND r.collection_id=v.collection_id AND r.view_id=v.view_id) latest
            FROM trait_catalog_views v JOIN trait_catalog_generations g ON g.generation=v.active_generation
            LEFT JOIN (SELECT view_id,COUNT(*) classified,COUNT(classification_error) errors,
                    CASE WHEN COUNT(scope_key)=COUNT(*) AND MIN(scope_key)=MAX(scope_key) THEN MIN(scope_key) END scope_key
                    FROM trait_catalog_members WHERE chain_id=? AND collection_id=? ${viewId === undefined ? "" : "AND view_id=?"} GROUP BY view_id) m ON m.view_id=v.view_id
            WHERE v.chain_id=? AND v.collection_id=? ${viewId === undefined ? "" : "AND v.view_id=?"} ORDER BY v.view_id`,
            )
            .all(...bindScope, ...bindScope) as {
            scope_key: string | null;
            descriptor_json: string;
            active_generation: number;
            mapper_version: string;
            ready: number;
            failed: number;
            classified: number;
            latest: number | null;
        }[];
        return rows.map((row) => {
            const descriptor: CollectionViewDescriptor = JSON.parse(
                row.descriptor_json,
            );
            return {
                ...descriptor,
                pinnedTraits: row.scope_key
                    ? descriptor.pinnedTraits.map((pin) => ({
                          ...pin,
                          key: row.scope_key!,
                      }))
                    : [],

                classified: row.classified,
                ready: row.ready,
                failed: row.failed,
                generation: row.active_generation,
                activeMapperVersion: row.mapper_version,
                structure: mapper.structure?.(descriptor, row.mapper_version),
                availableMapperVersion: mapper.availableVersion(descriptor),
                latestRun:
                    (row.latest &&
                        getTraitCatalogRebuild(
                            chainId,
                            collectionId,
                            row.latest,
                        )) ||
                    null,
            };
        });
    })();
}

function activeGeneration(scope: Scope) {
    // A scalar subquery also returns a row for a missing view, allowing
    // synchronous and streaming readers to apply the same generation check.
    return db.raw
        .prepare(
            "SELECT (SELECT active_generation FROM trait_catalog_views WHERE chain_id=? AND collection_id=? AND view_id=?)",
        )
        .pluck()
        .bind(scope.chainId, scope.collectionId, scope.traitContext.viewId);
}

function requireActiveGeneration(scope: Scope, active: unknown): void {
    if (
        active === null ||
        (scope.traitContext.generation !== null &&
            active !== scope.traitContext.generation)
    )
        throw new ReadModelBadRequestError(
            "Collection view changed. Reload the view.",
        );
}

/** Evaluate page, includes and statistics against the same published generation. */
export function withTraitReadSnapshot<T>(scope: Scope, read: () => T): T {
    return db.raw.transaction(() => {
        if (scope.traitContext.viewId !== null)
            requireActiveGeneration(scope, activeGeneration(scope).get());
        return read();
    })();
}

/** The generation cursor stays open until the streamed read finishes (including early return).
 * SQLite therefore pins its WAL read snapshot across validation and the dependent statements. */
export function* iterateTraitReadSnapshot<T>(
    scope: Scope,
    read: () => Iterable<T>,
): IterableIterator<T> {
    if (scope.traitContext.viewId === null) {
        yield* read();
        return;
    }
    for (const active of activeGeneration(scope).iterate()) {
        requireActiveGeneration(scope, active);
        yield* read();
    }
}

function viewMembers(scope: Scope): Sql {
    return {
        sql: "SELECT token_id FROM trait_catalog_members WHERE chain_id=? AND collection_id=? AND view_id=?",
        values: [scope.chainId, scope.collectionId, scope.traitContext.viewId!],
    };
}

/** The projection FK ties every link to the current source revision. */
function valuesRelation(scope: Scope): Sql {
    const { chainId, collectionId, traitContext } = scope;
    if (traitContext.catalog === TRAIT_CATALOG.Derived) {
        if (traitContext.viewId === null || traitContext.generation === null)
            throw new ReadModelBadRequestError("Choose a collection view");
        return {
            sql: `SELECT token_id,field_id AS key,value,native_key,native_value,native_field_key FROM trait_catalog_values WHERE chain_id=? AND collection_id=? AND view_id=? AND generation=?`,
            values: [
                chainId,
                collectionId,
                traitContext.viewId,
                traitContext.generation,
            ],
        };
    }
    const members = traitContext.viewId === null ? null : viewMembers(scope);
    return {
        sql: `SELECT token_id,key,value,key AS native_key,value AS native_value,key AS native_field_key FROM (${CANONICAL_TRAIT_RELATION_SQL}) WHERE chain_id=? AND collection_id=? ${members ? `AND token_id IN (${members.sql})` : ""}`,
        values: [chainId, collectionId, ...(members?.values ?? [])],
    };
}

/** Bound membership before applying any same-key OR selections. Keep token sets inside SQLite. */
export function buildCatalogTokenPredicate(
    params: Scope & {
        tokenColumnSql: string;
        traitFilterGroups?: TraitFilterGroup[];
        traitRangeFilterGroups?: TraitRangeFilterGroup[];
    },
): Sql {
    const { tokenColumnSql, traitContext } = params;
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (traitContext.viewId !== null) {
        const members = viewMembers(params);
        conditions.push(`${tokenColumnSql} IN (${members.sql})`);
        values.push(...members.values);
    }
    const relation = valuesRelation(params);
    function constrain(predicate: string, args: string[]) {
        conditions.push(
            `${tokenColumnSql} IN (SELECT token_id FROM (${relation.sql}) WHERE ${predicate})`,
        );
        values.push(...relation.values, ...args);
    }
    for (const group of params.traitFilterGroups ?? []) {
        constrain(`key=? AND value IN (SELECT value FROM json_each(?))`, [
            group.key,
            JSON.stringify(group.values),
        ]);
    }
    for (const group of params.traitRangeFilterGroups ?? []) {
        const predicates = [
            "key=?",
            "value <> ''",
            "value NOT GLOB '*[^0-9]*'",
        ];
        const args = [group.key];
        // Compare normalized unsigned decimals without SQLite's signed 64-bit saturation.
        const normalized = "COALESCE(NULLIF(LTRIM(value,'0'),''),'0')";
        for (const [bound, operator] of [
            [group.fromValue, ">="],
            [group.toValue, "<="],
        ] as const) {
            if (bound === null) continue;
            const digits = BigInt(bound).toString();
            predicates.push(
                `(length(${normalized}),${normalized}) ${operator} (length(?),?)`,
            );
            args.push(digits, digits);
        }
        constrain(predicates.join(" AND "), args);
    }
    return { sql: conditions.join(" AND ") || "1", values };
}

export function readCatalogAttributes(
    scope: Scope,
    tokenIds: string[],
): Map<string, TraitFilter[]> {
    const relation = valuesRelation(scope);
    const rows = db.raw
        .prepare(
            `SELECT token_id,key,value FROM (${relation.sql}) WHERE token_id IN (SELECT value FROM json_each(?)) ORDER BY token_id,key,value`,
        )
        .iterate(...relation.values, JSON.stringify(tokenIds)) as Iterable<{
        token_id: string;
        key: string;
        value: string;
    }>;
    const result = new Map<string, TraitFilter[]>();
    for (const { token_id, key, value } of rows) {
        let attrs = result.get(token_id);
        if (!attrs) result.set(token_id, (attrs = []));
        attrs.push({ key, value });
    }
    return result;
}

export function readCatalogFacets(
    scope: Scope,
    options: {
        keys?: string[];
        excludeKeys?: string[];
        owner?: string;
        traitFilterGroups?: TraitFilterGroup[];
        tokenId?: string;
    } = {},
): TraitFacet[] {
    const relation = valuesRelation(scope);
    const where = ["1"];
    const args = [...relation.values];
    if (options.keys || options.excludeKeys?.length) {
        where.push(
            `key ${options.keys ? "IN" : "NOT IN"} (SELECT value FROM json_each(?))`,
        );
        args.push(JSON.stringify(options.keys ?? options.excludeKeys));
    }
    if (options.owner) {
        where.push(
            "token_id IN (SELECT token_id FROM nft_balances WHERE chain_id=? AND collection_id=? AND owner=? AND CAST(amount AS INTEGER)>0)",
        );
        args.push(scope.chainId, scope.collectionId, options.owner);
    }
    if (options.traitFilterGroups?.length) {
        const filter = buildCatalogTokenPredicate({
            ...scope,
            tokenColumnSql: "token_id",
            traitFilterGroups: options.traitFilterGroups,
        });
        where.push(filter.sql);
        args.push(...filter.values);
    }
    if (options.tokenId !== undefined) {
        where.push(
            "(key,value) IN (SELECT key,value FROM facts WHERE token_id=?)",
        );
        args.push(options.tokenId);
    }
    const rows = db.raw
        .prepare(
            `WITH facts AS NOT MATERIALIZED (${relation.sql}) SELECT key,value,COUNT(DISTINCT token_id) n,
        CASE WHEN COUNT(native_key)=COUNT(*) AND MIN(native_key)=MAX(native_key) AND COUNT(native_value)=COUNT(*) AND MIN(native_value)=MAX(native_value)
             THEN MIN(native_key) END native_key, MIN(native_value) native_value,
          CASE WHEN COUNT(native_field_key)=COUNT(*) AND MIN(native_field_key)=MAX(native_field_key) THEN MIN(native_field_key) END native_field_key
        FROM facts WHERE ${where.join(" AND ")} GROUP BY key,value ORDER BY key,n,value`,
        )
        .iterate(...args) as Iterable<{
        key: string;
        value: string;
        n: number;
        native_key: string | null;
        native_value: string;
        native_field_key: string | null;
    }>;
    const byKey = new Map<string, TraitFacet>();
    for (const row of rows) {
        let facet = byKey.get(row.key);
        if (!facet)
            byKey.set(
                row.key,
                (facet = {
                    key: row.key,
                    displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
                    minValue: null,
                    maxValue: null,
                    values: [],
                }),
            );
        const native =
            row.native_key === null
                ? null
                : { key: row.native_key, value: row.native_value };
        const fieldKey = row.native_field_key;
        facet.nativeKey =
            facet.values.length === 0
                ? fieldKey
                : facet.nativeKey === fieldKey
                  ? fieldKey
                  : null;
        facet.values.push({
            value: row.value,
            tokenCount: row.n,
            native,
            marketplaceBiddingSupported: native !== null,
        });
    }
    return [...byKey.values()];
}

export function ensureCatalogToken(scope: Scope, tokenId: string): void {
    if (
        scope.traitContext.viewId !== null &&
        readTokenViewId(scope.chainId, scope.collectionId, tokenId) !==
            scope.traitContext.viewId
    )
        throw new ReadModelNotFoundError("Token is outside this view");
}

export function readTraitTree(
    scope: Scope,
    tokenId: string,
): TraitNode[] | null | undefined {
    if (scope.traitContext.catalog !== TRAIT_CATALOG.Derived) return undefined;
    const raw = db.raw
        .prepare(
            "SELECT tree_json FROM trait_catalog_projections WHERE chain_id=? AND collection_id=? AND view_id=? AND generation=? AND token_id=?",
        )
        .pluck()
        .get(
            scope.chainId,
            scope.collectionId,
            scope.traitContext.viewId,
            scope.traitContext.generation,
            tokenId,
        );
    return typeof raw === "string" ? JSON.parse(raw) : null;
}

export function readCatalogTokenDetailTraits(
    scope: Scope,
    tokenId: string,
): TokenDetailTrait[] {
    const members =
        scope.traitContext.viewId === null
            ? {
                  sql: "SELECT token_id FROM tokens WHERE chain_id=? AND collection_id=?",
                  values: [scope.chainId, scope.collectionId],
              }
            : viewMembers(scope);
    const total = db.raw
        .prepare(`SELECT COUNT(*) FROM (${members.sql})`)
        .pluck()
        .get(...members.values) as number;
    return readCatalogFacets(scope, { tokenId }).flatMap((facet) =>
        facet.values.map((value) => ({
            ...value,
            key: facet.key,
            rarityPercent: total > 0 ? (100 * value.tokenCount) / total : null,
        })),
    );
}
