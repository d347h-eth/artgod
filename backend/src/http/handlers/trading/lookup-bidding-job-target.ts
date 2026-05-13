import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    BiddingJobTargetLookupInput,
    BiddingJobTargetLookupOutput,
} from "../../../application/use-cases/trading/bidding-job-target-lookup.js";
import { parseOptionalQuantity } from "./trading-job-http.js";

export type LookupBiddingJobTargetRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Body: {
        target?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class LookupBiddingJobTargetHttpAdapter {
    constructor(
        readonly lookupBiddingJobTargetPort: {
            lookupBiddingJobTarget(
                input: BiddingJobTargetLookupInput,
            ): MaybePromise<BiddingJobTargetLookupOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<LookupBiddingJobTargetRoute>,
    ) => {
        return await this.lookupBiddingJobTargetPort.lookupBiddingJobTarget(
            this.mapRequestToInput(request),
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<LookupBiddingJobTargetRoute>,
    ): BiddingJobTargetLookupInput {
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            target: parseLookupTarget(request.body?.target),
        };
    }
}

function parseLookupTarget(value: unknown): BiddingJobTargetLookupInput["target"] {
    if (!value || typeof value !== "object") {
        throw new ReadModelBadRequestError("target is required");
    }
    const record = value as Record<string, unknown>;
    if (record.type === "token") {
        return {
            type: "token",
            tokenId: parseRequiredString(record.tokenId, "target.tokenId"),
        };
    }
    if (record.type === "collection") {
        return {
            type: "collection",
            quantity: parseOptionalQuantity(record.quantity, "target.quantity"),
        };
    }
    if (record.type === "trait") {
        return {
            type: "trait",
            quantity: parseOptionalQuantity(record.quantity, "target.quantity"),
            targetTraits: parseTargetTraits(record.targetTraits),
        };
    }
    throw new ReadModelBadRequestError("target.type is invalid");
}

function parseTargetTraits(value: unknown): { type: string; value: string }[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new ReadModelBadRequestError("target.targetTraits is required");
    }
    return value.map((entry) => {
        if (!entry || typeof entry !== "object") {
            throw new ReadModelBadRequestError("target.targetTraits entries must be objects");
        }
        const record = entry as Record<string, unknown>;
        return {
            type: parseRequiredString(record.type, "target.targetTraits.type"),
            value: parseRequiredString(record.value, "target.targetTraits.value"),
        };
    });
}

function parseRequiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new ReadModelBadRequestError(`${field} is required`);
    }
    return value.trim();
}
