import type { FastifyRequest } from "fastify";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";
import type { SpanAttributes } from "@artgod/shared/observability/apm";
import type {
    GetCollectionDetailInput,
    GetCollectionDetailOutput,
    GetCollectionDetailPort,
} from "../../../application/use-cases/collections/get-collection-detail.js";
import {
    getSearchParams,
    parseCursor,
    parseLimit,
    parseMediaMode,
    parseOwner,
    parseTokenBrowserStatus,
    parseTraits,
    parseTraitRanges,
} from "../../common/request-query.js";

export type GetCollectionDetailRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

export class GetCollectionDetailHttpAdapter {
    constructor(readonly getCollectionDetailPort: GetCollectionDetailPort) {}

    readonly handle = async (
        request: FastifyRequest<GetCollectionDetailRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output =
            await this.getCollectionDetailPort.getCollectionDetail(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetCollectionDetailRoute>,
    ): GetCollectionDetailInput {
        const searchParams = getSearchParams(request);
        const tokenStatus = parseTokenBrowserStatus(
            searchParams.get("token_status"),
        );
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));
        const owner = parseOwner(searchParams.get("owner"));
        const traits = parseTraits(searchParams);
        const traitRanges = parseTraitRanges(searchParams);
        const mediaMode = parseMediaMode(searchParams.get("media_mode"));

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenStatus,
            limit,
            cursor: cursor ?? undefined,
            traits,
            traitRanges,
            owner,
            mediaMode,
        };
    }

    private mapOutputToResponse(
        output: GetCollectionDetailOutput,
    ): GetCollectionDetailOutput {
        return output;
    }
}

// Captures low-cardinality collection-detail request shape for slow-route traces.
export function getCollectionDetailSpanAttributes(
    request: FastifyRequest<GetCollectionDetailRoute>,
): SpanAttributes {
    const searchParams = getSearchParams(request);
    return {
        "artgod.collection.limit": parseLimitAttribute(
            searchParams.get("limit"),
        ),
        "artgod.collection.limit_present": hasQueryValue(searchParams, "limit"),
        "artgod.collection.cursor_present": hasQueryValue(
            searchParams,
            "cursor",
        ),
        "artgod.collection.token_status": normalizeTokenStatusAttribute(
            searchParams.get("token_status"),
        ),
        "artgod.collection.owner_present": hasQueryValue(searchParams, "owner"),
        "artgod.collection.trait_filters_count": countDelimitedQuerySegments(
            searchParams,
            ["traits", "trait"],
        ),
        "artgod.collection.trait_ranges_count": countDelimitedQuerySegments(
            searchParams,
            ["trait_ranges", "trait_range"],
        ),
        "artgod.collection.media_mode_present": hasQueryValue(
            searchParams,
            COLLECTION_MEDIA_QUERY_PARAMS.MediaMode,
        ),
    };
}

function parseLimitAttribute(raw: string | null): number | undefined {
    const value = raw?.trim();
    if (!value || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizeTokenStatusAttribute(raw: string | null): string {
    const value = raw?.trim();
    if (!value) return "listed";
    return value === "listed" ||
        value === "all" ||
        value === "listed_then_unlisted"
        ? value
        : "invalid";
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

function hasQueryValue(searchParams: URLSearchParams, key: string): boolean {
    return searchParams.getAll(key).some((value) => value.trim().length > 0);
}
