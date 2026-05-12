import type { FastifyRequest } from "fastify";
import type {
    UpsertTokenBiddingJobInput,
    UpsertTokenBiddingJobOutput,
} from "../../../application/use-cases/trading/upsert-token-bidding-job.js";
import {
    parseEditableBiddingJobStatus,
    parseOptionalString,
    parseRequiredString,
} from "./trading-job-http.js";

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
        priceTierId?: unknown;
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
            status: parseEditableBiddingJobStatus(request.body?.status),
            floorEth: parseOptionalString(request.body?.floorEth, "floorEth"),
            ceilingEth: parseOptionalString(request.body?.ceilingEth, "ceilingEth"),
            deltaEth: parseRequiredString(request.body?.deltaEth, "deltaEth"),
            priceTierId: parseOptionalString(request.body?.priceTierId, "priceTierId"),
        };
    }
}
