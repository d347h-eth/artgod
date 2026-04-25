import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import { TRADING_JOB_STATUS } from "@artgod/shared/types";
import type {
    UpsertTokenBiddingJobInput,
    UpsertTokenBiddingJobOutput,
} from "../../../application/use-cases/trading/upsert-token-bidding-job.js";

export type UpsertTokenBiddingJobRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        token_ref: string;
    };
    Body: {
        status?: unknown;
        floorEth?: unknown;
        ceilingEth?: unknown;
        deltaEth?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class UpsertTokenBiddingJobHttpAdapter {
    constructor(
        readonly upsertTokenBiddingJobPort: {
            upsertTokenBiddingJob(
                input: UpsertTokenBiddingJobInput,
            ): MaybePromise<UpsertTokenBiddingJobOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<UpsertTokenBiddingJobRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return await this.upsertTokenBiddingJobPort.upsertTokenBiddingJob(input);
    };

    private mapRequestToInput(
        request: FastifyRequest<UpsertTokenBiddingJobRoute>,
    ): UpsertTokenBiddingJobInput {
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenRef: request.params.token_ref,
            status: parseJobStatus(request.body?.status),
            floorEth: parseRequiredString(request.body?.floorEth, "floorEth"),
            ceilingEth: parseRequiredString(
                request.body?.ceilingEth,
                "ceilingEth",
            ),
            deltaEth: parseRequiredString(request.body?.deltaEth, "deltaEth"),
        };
    }
}

function parseJobStatus(
    value: unknown,
): typeof TRADING_JOB_STATUS.Enabled | typeof TRADING_JOB_STATUS.Paused {
    if (
        value === TRADING_JOB_STATUS.Enabled ||
        value === TRADING_JOB_STATUS.Paused
    ) {
        return value;
    }
    throw new ReadModelBadRequestError("status is invalid");
}

function parseRequiredString(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError(`${field} must be a string`);
    }
    return value;
}
