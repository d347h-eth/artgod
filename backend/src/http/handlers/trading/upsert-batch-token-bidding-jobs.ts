import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    TokenBrowserStatus,
    TraitFilter,
    TraitRangeFilter,
    CollectionBiddingTraitFilterJoinMode,
} from "@artgod/shared/types";
import {
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
} from "@artgod/shared/types";
import type {
    UpsertBatchTokenBiddingJobsInput,
    UpsertBatchTokenBiddingJobsOutput,
} from "../../../application/use-cases/trading/upsert-batch-token-bidding-jobs.js";
import {
    parseEditableBiddingJobStatus,
    parseOptionalString as parseOptionalBodyString,
    parseRequiredString,
} from "./trading-job-http.js";

export type UpsertBatchTokenBiddingJobsRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Body: {
        status?: unknown;
        floorEth?: unknown;
        ceilingEth?: unknown;
        deltaEth?: unknown;
        priceTierId?: unknown;
        selection?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class UpsertBatchTokenBiddingJobsHttpAdapter {
    constructor(
        readonly upsertBatchTokenBiddingJobsPort: {
            upsertBatchTokenBiddingJobs(
                input: UpsertBatchTokenBiddingJobsInput,
            ): MaybePromise<UpsertBatchTokenBiddingJobsOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<UpsertBatchTokenBiddingJobsRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return await this.upsertBatchTokenBiddingJobsPort.upsertBatchTokenBiddingJobs(
            input,
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<UpsertBatchTokenBiddingJobsRoute>,
    ): UpsertBatchTokenBiddingJobsInput {
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            status: parseEditableBiddingJobStatus(request.body?.status),
            floorEth: parseOptionalBodyString(request.body?.floorEth, "floorEth"),
            ceilingEth: parseOptionalBodyString(request.body?.ceilingEth, "ceilingEth"),
            deltaEth: parseRequiredString(request.body?.deltaEth, "deltaEth"),
            priceTierId: parseOptionalBodyString(
                request.body?.priceTierId,
                "priceTierId",
            ),
            selection: parseBatchTokenBiddingJobSelection(
                request.body?.selection,
            ),
        };
    }
}

export function parseBatchTokenBiddingJobSelection(
    value: unknown,
): UpsertBatchTokenBiddingJobsInput["selection"] {
    if (!value || typeof value !== "object") {
        throw new ReadModelBadRequestError("selection is required");
    }
    const record = value as Record<string, unknown>;
    if (record.type === TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds) {
        return {
            type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds,
            tokenIds: parseStringArray(record.tokenIds, "selection.tokenIds"),
        };
    }
    if (
        record.type ===
        TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenBrowserFilter
    ) {
        return {
            type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenBrowserFilter,
            tokenStatus: parseTokenStatus(record.tokenStatus),
            traits: parseTraits(record.traits),
            traitRanges: parseTraitRanges(record.traitRanges),
        };
    }
    if (
        record.type ===
        TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter
    ) {
        return {
            type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter,
            traits: parseTraits(record.traits),
            traitRanges: parseTraitRanges(record.traitRanges),
            traitJoinMode: parseTraitJoinMode(record.traitJoinMode),
            makerAddress: parseOptionalString(
                record.makerAddress,
                "selection.makerAddress",
            ),
        };
    }
    throw new ReadModelBadRequestError("selection.type is invalid");
}

function parseTokenStatus(value: unknown): TokenBrowserStatus {
    if (
        value === "listed" ||
        value === "all" ||
        value === "listed_then_unlisted"
    ) {
        return value;
    }
    throw new ReadModelBadRequestError("selection.tokenStatus is invalid");
}

function parseTraitJoinMode(value: unknown): CollectionBiddingTraitFilterJoinMode {
    if (
        value === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And ||
        value === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or
    ) {
        return value;
    }
    throw new ReadModelBadRequestError("selection.traitJoinMode is invalid");
}

function parseTraits(value: unknown): TraitFilter[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new ReadModelBadRequestError("selection.traits must be an array");
    }
    return value.map((entry) => parseTrait(entry, "selection.traits"));
}

function parseTraitRanges(value: unknown): TraitRangeFilter[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new ReadModelBadRequestError("selection.traitRanges must be an array");
    }
    return value.map((entry) => {
        if (!entry || typeof entry !== "object") {
            throw new ReadModelBadRequestError("selection.traitRanges entries must be objects");
        }
        const record = entry as Record<string, unknown>;
        return {
            key: parseRequiredString(record.key, "selection.traitRanges.key"),
            fromValue: parseOptionalString(record.fromValue, "selection.traitRanges.fromValue"),
            toValue: parseOptionalString(record.toValue, "selection.traitRanges.toValue"),
        };
    });
}

function parseTrait(value: unknown, field: string): TraitFilter {
    if (!value || typeof value !== "object") {
        throw new ReadModelBadRequestError(`${field} entries must be objects`);
    }
    const record = value as Record<string, unknown>;
    return {
        key: parseRequiredString(record.key, `${field}.key`),
        value: parseRequiredString(record.value, `${field}.value`),
    };
}

function parseOptionalString(value: unknown, field: string): string | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError(`${field} must be a string`);
    }
    return value;
}

function parseStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
        throw new ReadModelBadRequestError(`${field} must be an array`);
    }
    return value.map((entry) => parseRequiredString(entry, field));
}
