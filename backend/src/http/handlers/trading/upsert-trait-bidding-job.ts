import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    UpsertTraitBiddingJobInput,
    UpsertTraitBiddingJobOutput,
} from "../../../application/use-cases/trading/upsert-trait-bidding-job.js";
import {
    parseEditableBiddingJobStatus,
    parseRequiredString,
} from "./trading-job-http.js";

export type UpsertTraitBiddingJobRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Body: {
        status?: unknown;
        floorEth?: unknown;
        ceilingEth?: unknown;
        deltaEth?: unknown;
        quantity?: unknown;
        targetTraits?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class UpsertTraitBiddingJobHttpAdapter {
    constructor(
        readonly upsertTraitBiddingJobPort: {
            upsertTraitBiddingJob(
                input: UpsertTraitBiddingJobInput,
            ): MaybePromise<UpsertTraitBiddingJobOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<UpsertTraitBiddingJobRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return await this.upsertTraitBiddingJobPort.upsertTraitBiddingJob(
            input,
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<UpsertTraitBiddingJobRoute>,
    ): UpsertTraitBiddingJobInput {
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            status: parseEditableBiddingJobStatus(request.body?.status),
            floorEth: parseRequiredString(request.body?.floorEth, "floorEth"),
            ceilingEth: parseRequiredString(
                request.body?.ceilingEth,
                "ceilingEth",
            ),
            deltaEth: parseRequiredString(request.body?.deltaEth, "deltaEth"),
            quantity: parseOptionalQuantity(request.body?.quantity),
            targetTraits: parseTargetTraits(request.body?.targetTraits),
        };
    }
}

function parseOptionalQuantity(value: unknown): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new ReadModelBadRequestError("quantity must be an integer > 0");
    }
    return value;
}

function parseTargetTraits(value: unknown): { type: string; value: string }[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new ReadModelBadRequestError("targetTraits is required");
    }
    return value.map((entry) => {
        if (!entry || typeof entry !== "object") {
            throw new ReadModelBadRequestError("targetTraits entries must be objects");
        }
        const record = entry as Record<string, unknown>;
        return {
            type: parseRequiredString(record.type, "targetTraits.type"),
            value: parseRequiredString(record.value, "targetTraits.value"),
        };
    });
}
