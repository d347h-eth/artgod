import type { FastifyRequest } from "fastify";
import { DEFAULT_PAGE_LIMIT } from "@artgod/shared/config/pagination";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    CollectionStatus,
    TraitFilter,
} from "@artgod/shared/types/browse";

const ALLOWED_COLLECTION_STATUSES = new Set<CollectionStatus>([
    "bootstrapping",
    "live",
    "paused",
    "disabled",
]);

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

export function parseCursor(raw: string | null): string | null {
    if (!raw || !raw.trim()) return null;
    return raw.trim();
}

export function parseTraits(searchParams: URLSearchParams): TraitFilter[] {
    const values = [
        ...searchParams.getAll("traits"),
        ...searchParams.getAll("trait"),
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
