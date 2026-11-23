import type { FastifyRequest } from "fastify";
import {
    TRAIT_CATALOG,
    TRAIT_CATALOG_QUERY,
} from "@artgod/shared/types/trait-catalog";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type { CatalogRequest } from "../../application/use-cases/collections/collection-views.js";
import { getSearchParams } from "./request-query.js";

export function catalogRequest(request: FastifyRequest): CatalogRequest {
    const search = getSearchParams(request);
    if (
        Object.values(TRAIT_CATALOG_QUERY).some(
            (key) => search.getAll(key).length > 1,
        )
    )
        throw new ReadModelBadRequestError(
            "Choose one catalog, view and generation",
        );
    const view = search.get(TRAIT_CATALOG_QUERY.View);
    const traitCatalog = search.get(TRAIT_CATALOG_QUERY.Catalog);
    const generation = search.get(TRAIT_CATALOG_QUERY.Generation);
    if (
        view === "" ||
        (traitCatalog !== null &&
            traitCatalog !== TRAIT_CATALOG.Canonical &&
            traitCatalog !== TRAIT_CATALOG.Derived)
    )
        throw new ReadModelBadRequestError("Invalid trait catalog or view");
    return {
        ...(view ? { view } : {}),
        ...(traitCatalog ? { traitCatalog } : {}),
        ...(generation !== null
            ? { generation: positiveInteger(generation) }
            : {}),
    };
}

export function positiveInteger(raw: unknown): number {
    if (
        (typeof raw !== "string" && typeof raw !== "number") ||
        !/^[1-9]\d*$/.test(String(raw)) ||
        !Number.isSafeInteger(Number(raw))
    )
        throw new ReadModelBadRequestError("Expected a positive integer");
    return Number(raw);
}
