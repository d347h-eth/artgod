import type { FastifyRequest, FastifyReply } from "fastify";
import {
    BOOTSTRAP_OPERATION,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
import { bootstrapOperationResponse } from "./operation-response.js";
import { BOOTSTRAP_API_QUERY_PARAM } from "@artgod/shared/http/bootstrap-routes";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    ProbeOpenSeaCollectionSlugInput,
    ProbeOpenSeaCollectionSlugOutput,
} from "../../../application/use-cases/bootstrap/probe-opensea-collection-slug.js";

export type ProbeOpenSeaCollectionSlugRoute = {
    Params: {
        chain_ref: string;
    };
    Querystring: {
        address?: string;
        slug?: string;
        sample_token_id?: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ProbeOpenSeaCollectionSlugHttpAdapter {
    constructor(
        private readonly probeOpenSeaCollectionSlugPort: {
            probe(
                input: ProbeOpenSeaCollectionSlugInput,
                report?: BootstrapOutputReporter,
            ): MaybePromise<ProbeOpenSeaCollectionSlugOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ProbeOpenSeaCollectionSlugRoute>,
        reply: FastifyReply,
    ) => {
        const input = this.mapRequestToInput(request);
        return bootstrapOperationResponse(
            request,
            reply,
            BOOTSTRAP_OPERATION.Resolve,
            (report) =>
                this.probeOpenSeaCollectionSlugPort.probe(input, report),
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<ProbeOpenSeaCollectionSlugRoute>,
    ): ProbeOpenSeaCollectionSlugInput {
        return {
            chainRef: request.params.chain_ref,
            address:
                optionalString(
                    request.query[BOOTSTRAP_API_QUERY_PARAM.Address],
                ) ?? "",
            slug: optionalString(request.query[BOOTSTRAP_API_QUERY_PARAM.Slug]),
            sampleTokenId: optionalString(
                request.query[BOOTSTRAP_API_QUERY_PARAM.SampleTokenId],
            ),
        };
    }
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError("query value must be a string");
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
