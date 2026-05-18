import type { FastifyRequest } from "fastify";
import { DEFAULT_PAGE_LIMIT } from "@artgod/shared/config/pagination";
import type { CollectionMediaMode } from "@artgod/shared/extensions";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    isAddressRef,
    normalizeAddressRef,
} from "@artgod/shared/utils/ref-resolver";
import {
    ACTIVITY_FEED_FILTER_KIND,
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_BID_SCOPE_FILTERS,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODES,
    TRAIT_FILTER_QUERY_PARAMS,
    TOKEN_BROWSER_STATUS,
    type ActivityFeedFilterKind,
    type CollectionBiddingBidScopeFilter,
    type CollectionBiddingTraitFilterJoinMode,
} from "@artgod/shared/types";
import type {
    CollectionStatus,
    TokenBrowserStatus,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import type {
    BootstrapMetadataTaskStatus,
    BootstrapRunStatus,
} from "../../application/use-cases/bootstrap/types.js";

const ALLOWED_COLLECTION_STATUSES = new Set<CollectionStatus>([
    "bootstrapping",
    "live",
    "paused",
    "disabled",
]);

const ALLOWED_TOKEN_BROWSER_STATUSES = new Set<TokenBrowserStatus>([
    TOKEN_BROWSER_STATUS.Listed,
    TOKEN_BROWSER_STATUS.All,
    TOKEN_BROWSER_STATUS.ListedThenUnlisted,
]);

const ALLOWED_BOOTSTRAP_TASK_STATUSES = new Set<BootstrapMetadataTaskStatus>([
    "pending",
    "retry",
    "succeeded",
    "failed_terminal",
]);

const ALLOWED_BOOTSTRAP_RUN_STATUSES = new Set<BootstrapRunStatus>([
    "requested",
    "queued",
    "metadata",
    "ownership",
    "backfill",
    "completed",
    "failed",
]);

const ALLOWED_ACTIVITY_FILTER_KINDS = new Set<ActivityFeedFilterKind>([
    ACTIVITY_FEED_FILTER_KIND.Sales,
    ACTIVITY_FEED_FILTER_KIND.Listings,
    ACTIVITY_FEED_FILTER_KIND.Transfers,
]);

const ALLOWED_COLLECTION_BIDDING_BID_SCOPE_FILTERS =
    new Set<CollectionBiddingBidScopeFilter>(
        COLLECTION_BIDDING_BID_SCOPE_FILTERS,
    );
const ALLOWED_COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODES =
    new Set<CollectionBiddingTraitFilterJoinMode>(
        COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODES,
    );

export function getSearchParams(request: FastifyRequest): URLSearchParams {
    return new URL(request.raw.url ?? "/", "http://localhost").searchParams;
}

export function parseStatus(raw: string | null): CollectionStatus | undefined {
    if (!raw || !raw.trim()) return undefined;
    if (!ALLOWED_COLLECTION_STATUSES.has(raw as CollectionStatus)) {
        throw new ReadModelBadRequestError("Invalid status");
    }
    return raw as CollectionStatus;
}

export function parseLimit(raw: string | null): number {
    if (!raw || !raw.trim()) return DEFAULT_PAGE_LIMIT;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ReadModelBadRequestError("Invalid limit");
    }
    return parsed;
}

export function parseOptionalInteger(
    raw: string | null,
    field: string,
): number | null {
    if (!raw || !raw.trim()) return null;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
        throw new ReadModelBadRequestError(`Invalid ${field}`);
    }
    return parsed;
}

export function parseCursor(raw: string | null): string | null {
    if (!raw || !raw.trim()) return null;
    return raw.trim();
}

export function parseActivityFilterKind(
    raw: string | null,
): ActivityFeedFilterKind | undefined {
    if (!raw || !raw.trim()) return undefined;
    if (!ALLOWED_ACTIVITY_FILTER_KINDS.has(raw as ActivityFeedFilterKind)) {
        throw new ReadModelBadRequestError("Invalid kind");
    }
    return raw as ActivityFeedFilterKind;
}

export function parseCollectionBiddingBidScopeFilter(
    raw: string | null,
): CollectionBiddingBidScopeFilter {
    if (!raw || !raw.trim()) {
        return COLLECTION_BIDDING_BID_SCOPE_FILTER.Token;
    }
    if (
        !ALLOWED_COLLECTION_BIDDING_BID_SCOPE_FILTERS.has(
            raw as CollectionBiddingBidScopeFilter,
        )
    ) {
        throw new ReadModelBadRequestError("Invalid bid scope filter");
    }
    return raw as CollectionBiddingBidScopeFilter;
}

export function parseCollectionBiddingTraitFilterJoinMode(
    raw: string | null,
): CollectionBiddingTraitFilterJoinMode {
    if (!raw || !raw.trim()) {
        return COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or;
    }
    if (
        !ALLOWED_COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODES.has(
            raw as CollectionBiddingTraitFilterJoinMode,
        )
    ) {
        throw new ReadModelBadRequestError("Invalid bidding trait join mode");
    }
    return raw as CollectionBiddingTraitFilterJoinMode;
}

export function parseOwner(raw: string | null): string | undefined {
    return parseOptionalAddressRef(raw, "Invalid owner");
}

export function parseMaker(raw: string | null): string | undefined {
    return parseOptionalAddressRef(raw, "Invalid maker");
}

export function parseActivityTokenId(raw: string | null): string | undefined {
    if (!raw || !raw.trim()) return undefined;
    return parseUnsignedInteger(raw.trim(), "Invalid token_id");
}

export function parseContentHash(raw: string | null): string | undefined {
    if (!raw || !raw.trim()) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
        throw new ReadModelBadRequestError("Invalid content_hash");
    }
    return normalized;
}

export function parseActivityEventGroup(
    raw: string | null,
): string | undefined {
    if (!raw || !raw.trim()) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(normalized)) {
        throw new ReadModelBadRequestError("Invalid event_group");
    }
    return normalized;
}

export function parseExtensionEventRef(
    raw: string | null,
): { extensionKey: string; eventKey: string } | undefined {
    if (!raw || !raw.trim()) return undefined;
    const [extensionKey, eventKey, extra] = raw.trim().split(":");
    if (
        extra !== undefined ||
        !extensionKey ||
        !eventKey ||
        !/^[a-z0-9_-]+$/.test(extensionKey) ||
        !/^[a-z0-9_.-]+$/.test(eventKey)
    ) {
        throw new ReadModelBadRequestError("Invalid extension_event");
    }
    return {
        extensionKey,
        eventKey,
    };
}

function parseOptionalAddressRef(
    raw: string | null,
    invalidMessage: string,
): string | undefined {
    if (!raw || !raw.trim()) return undefined;
    if (!isAddressRef(raw)) {
        throw new ReadModelBadRequestError(invalidMessage);
    }
    return normalizeAddressRef(raw);
}

export function parseTokenBrowserStatus(
    raw: string | null,
): TokenBrowserStatus {
    if (!raw || !raw.trim()) return TOKEN_BROWSER_STATUS.Listed;
    if (!ALLOWED_TOKEN_BROWSER_STATUSES.has(raw as TokenBrowserStatus)) {
        throw new ReadModelBadRequestError("Invalid token_status");
    }
    return raw as TokenBrowserStatus;
}

export function parseBootstrapTaskStatus(
    raw: string | null,
): BootstrapMetadataTaskStatus | undefined {
    if (!raw || !raw.trim()) return undefined;
    if (
        !ALLOWED_BOOTSTRAP_TASK_STATUSES.has(raw as BootstrapMetadataTaskStatus)
    ) {
        throw new ReadModelBadRequestError("Invalid bootstrap task status");
    }
    return raw as BootstrapMetadataTaskStatus;
}

export function parseBootstrapRunStatus(
    raw: string | null,
): BootstrapRunStatus | undefined {
    if (!raw || !raw.trim()) return undefined;
    if (!ALLOWED_BOOTSTRAP_RUN_STATUSES.has(raw as BootstrapRunStatus)) {
        throw new ReadModelBadRequestError("Invalid bootstrap run status");
    }
    return raw as BootstrapRunStatus;
}

export function parseTraits(searchParams: URLSearchParams): TraitFilter[] {
    const values = [
        ...searchParams.getAll(TRAIT_FILTER_QUERY_PARAMS.Traits),
        ...searchParams.getAll(TRAIT_FILTER_QUERY_PARAMS.Trait),
    ];
    if (values.length === 0) return [];

    const parsed: TraitFilter[] = [];
    for (const value of values) {
        for (const segment of value.split(",")) {
            const trimmed = segment.trim();
            if (!trimmed) continue;
            const delimiter = trimmed.indexOf(":");
            if (delimiter <= 0 || delimiter === trimmed.length - 1) {
                throw new ReadModelBadRequestError("Invalid trait filter");
            }
            const key = trimmed.slice(0, delimiter).trim();
            const traitValue = trimmed.slice(delimiter + 1).trim();
            if (!key || !traitValue) {
                throw new ReadModelBadRequestError("Invalid trait filter");
            }
            parsed.push({ key, value: traitValue });
        }
    }
    return parsed;
}

export function parseTraitRanges(
    searchParams: URLSearchParams,
): TraitRangeFilter[] {
    const values = [
        ...searchParams.getAll(TRAIT_FILTER_QUERY_PARAMS.TraitRanges),
        ...searchParams.getAll(TRAIT_FILTER_QUERY_PARAMS.TraitRange),
    ];
    if (values.length === 0) return [];

    const parsed: TraitRangeFilter[] = [];
    const seen = new Set<string>();

    for (const value of values) {
        for (const segment of value.split(",")) {
            const trimmed = segment.trim();
            if (!trimmed) continue;

            const delimiter = trimmed.indexOf(":");
            if (delimiter <= 0 || delimiter === trimmed.length - 1) {
                throw new ReadModelBadRequestError("Invalid trait range filter");
            }

            const key = trimmed.slice(0, delimiter).trim();
            const bounds = trimmed.slice(delimiter + 1).trim();
            const rangeDelimiter = bounds.indexOf("..");
            if (rangeDelimiter < 0) {
                throw new ReadModelBadRequestError("Invalid trait range filter");
            }

            const rawFrom = bounds.slice(0, rangeDelimiter).trim();
            const rawTo = bounds.slice(rangeDelimiter + 2).trim();
            const fromValue = rawFrom ? parseUnsignedInteger(rawFrom) : null;
            const toValue = rawTo ? parseUnsignedInteger(rawTo) : null;
            if (fromValue === null && toValue === null) {
                throw new ReadModelBadRequestError("Invalid trait range filter");
            }
            if (
                fromValue !== null &&
                toValue !== null &&
                BigInt(fromValue) > BigInt(toValue)
            ) {
                throw new ReadModelBadRequestError("Invalid trait range filter");
            }
            if (!key) {
                throw new ReadModelBadRequestError("Invalid trait range filter");
            }
            if (seen.has(key)) {
                throw new ReadModelBadRequestError("Duplicate trait range filter");
            }
            seen.add(key);
            parsed.push({
                key,
                fromValue,
                toValue,
            });
        }
    }

    return parsed;
}

export function parseMediaMode(
    raw: string | null,
): CollectionMediaMode | undefined {
    if (!raw || !raw.trim()) {
        return undefined;
    }
    const normalized = raw.trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(normalized)) {
        throw new ReadModelBadRequestError("Invalid media_mode");
    }
    return normalized;
}

function parseUnsignedInteger(
    value: string,
    invalidMessage = "Invalid trait range filter",
): string {
    if (!/^\d+$/.test(value)) {
        throw new ReadModelBadRequestError(invalidMessage);
    }
    return value;
}
