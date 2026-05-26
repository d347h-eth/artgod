import type { FastifyRequest } from "fastify";
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import type { SpanAttributes } from "@artgod/shared/observability/apm";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import { TRAIT_CATALOG_QUERY_PARAMS } from "@artgod/shared/types";
import type {
    GetCollectionTraitCatalogInput,
    GetCollectionTraitCatalogOutput,
    GetCollectionTraitCatalogPort,
} from "../../../application/use-cases/collections/get-collection-trait-catalog.js";
import {
    getSearchParams,
    parseTraitFiltersFromValues,
} from "../../common/request-query.js";

export type GetCollectionTraitCatalogRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

export class GetCollectionTraitCatalogHttpAdapter {
    constructor(
        readonly getCollectionTraitCatalogPort: GetCollectionTraitCatalogPort,
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetCollectionTraitCatalogRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output =
            await this.getCollectionTraitCatalogPort.getCollectionTraitCatalog(
                input,
            );
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetCollectionTraitCatalogRoute>,
    ): GetCollectionTraitCatalogInput {
        const searchParams = getSearchParams(request);
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            keys: parseTraitCatalogKeys(searchParams),
            scopeTraitFilters: parseTraitFiltersFromValues(
                traitCatalogScopeValues(searchParams),
            ),
        };
    }

    private mapOutputToResponse(
        output: GetCollectionTraitCatalogOutput,
    ): GetCollectionTraitCatalogOutput {
        return output;
    }
}

// Captures request shape without logging concrete trait values.
export function getCollectionTraitCatalogSpanAttributes(
    request: FastifyRequest<GetCollectionTraitCatalogRoute>,
): SpanAttributes {
    const searchParams = getSearchParams(request);
    return {
        [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitCatalogKeysCount]:
            countDelimitedQuerySegments(searchParams, [
                TRAIT_CATALOG_QUERY_PARAMS.Keys,
                TRAIT_CATALOG_QUERY_PARAMS.Key,
            ]),
        [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitFiltersCount]:
            countDelimitedQuerySegments(searchParams, [
                TRAIT_CATALOG_QUERY_PARAMS.ScopeTraits,
                TRAIT_CATALOG_QUERY_PARAMS.ScopeTrait,
            ]),
    };
}

function parseTraitCatalogKeys(searchParams: URLSearchParams): string[] {
    const values = [
        ...searchParams.getAll(TRAIT_CATALOG_QUERY_PARAMS.Keys),
        ...searchParams.getAll(TRAIT_CATALOG_QUERY_PARAMS.Key),
    ];
    const keys = parseDelimitedQueryValues(values);
    if (keys.length === 0) {
        throw new ReadModelBadRequestError("Trait catalog keys are required");
    }
    return keys;
}

function traitCatalogScopeValues(searchParams: URLSearchParams): string[] {
    return [
        ...searchParams.getAll(TRAIT_CATALOG_QUERY_PARAMS.ScopeTraits),
        ...searchParams.getAll(TRAIT_CATALOG_QUERY_PARAMS.ScopeTrait),
    ];
}

function parseDelimitedQueryValues(values: string[]): string[] {
    const parsed: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        for (const segment of value.split(",")) {
            const trimmed = segment.trim();
            if (!trimmed || seen.has(trimmed)) {
                continue;
            }
            parsed.push(trimmed);
            seen.add(trimmed);
        }
    }
    return parsed;
}

function countDelimitedQuerySegments(
    searchParams: URLSearchParams,
    keys: string[],
): number {
    let count = 0;
    for (const key of keys) {
        for (const value of searchParams.getAll(key)) {
            count += value
                .split(",")
                .filter((segment) => segment.trim()).length;
        }
    }
    return count;
}
