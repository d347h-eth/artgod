import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    UpsertCollectionBiddingJobInput,
    UpsertCollectionBiddingJobOutput,
} from "../../../application/use-cases/trading/upsert-collection-bidding-job.js";
import {
    parseEditableBiddingJobStatus,
    parseOptionalString,
    parseRequiredString,
} from "./trading-job-http.js";

export type UpsertCollectionBiddingJobRoute = {
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
        quantity?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class UpsertCollectionBiddingJobHttpAdapter {
    constructor(
        readonly upsertCollectionBiddingJobPort: {
            upsertCollectionBiddingJob(
                input: UpsertCollectionBiddingJobInput,
            ): MaybePromise<UpsertCollectionBiddingJobOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<UpsertCollectionBiddingJobRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return await this.upsertCollectionBiddingJobPort.upsertCollectionBiddingJob(
            input,
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<UpsertCollectionBiddingJobRoute>,
    ): UpsertCollectionBiddingJobInput {
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            status: parseEditableBiddingJobStatus(request.body?.status),
            floorEth: parseOptionalString(request.body?.floorEth, "floorEth"),
            ceilingEth: parseOptionalString(request.body?.ceilingEth, "ceilingEth"),
            deltaEth: parseRequiredString(request.body?.deltaEth, "deltaEth"),
            priceTierId: parseOptionalString(request.body?.priceTierId, "priceTierId"),
            quantity: parseOptionalQuantity(request.body?.quantity),
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
