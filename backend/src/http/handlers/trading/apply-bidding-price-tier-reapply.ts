import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    ApplyBiddingPriceTierReapplyInput,
    ApplyBiddingPriceTierReapplyOutput,
} from "../../../application/use-cases/trading/apply-bidding-price-tier-reapply.js";

export type ApplyBiddingPriceTierReapplyRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        tier_id: string;
    };
    Body?: {
        jobIds?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ApplyBiddingPriceTierReapplyHttpAdapter {
    constructor(
        readonly applyBiddingPriceTierReapplyPort: {
            applyBiddingPriceTierReapply(
                input: ApplyBiddingPriceTierReapplyInput,
            ): MaybePromise<ApplyBiddingPriceTierReapplyOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ApplyBiddingPriceTierReapplyRoute>,
    ) => {
        return await this.applyBiddingPriceTierReapplyPort.applyBiddingPriceTierReapply(
            {
                chainRef: request.params.chain_ref,
                collectionRef: request.params.collection_ref,
                tierId: request.params.tier_id,
                jobIds: parseJobIds(request.body?.jobIds),
            },
        );
    };
}

function parseJobIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
        throw new ReadModelBadRequestError("jobIds must be an array");
    }
    return value.map((entry, index) => {
        if (typeof entry !== "string" || !entry.trim()) {
            throw new ReadModelBadRequestError(`jobIds[${index}] must be a string`);
        }
        return entry.trim();
    });
}
