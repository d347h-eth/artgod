import type { FastifyRequest } from "fastify";
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
        verification_token_id?: string | string[];
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ProbeOpenSeaCollectionSlugHttpAdapter {
    constructor(
        private readonly probeOpenSeaCollectionSlugPort: {
            probe(
                input: ProbeOpenSeaCollectionSlugInput,
            ): MaybePromise<ProbeOpenSeaCollectionSlugOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ProbeOpenSeaCollectionSlugRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return this.probeOpenSeaCollectionSlugPort.probe(input);
    };

    private mapRequestToInput(
        request: FastifyRequest<ProbeOpenSeaCollectionSlugRoute>,
    ): ProbeOpenSeaCollectionSlugInput {
        return {
            chainRef: request.params.chain_ref,
            address: optionalString(
                request.query[BOOTSTRAP_API_QUERY_PARAM.Address],
            ),
            slug: optionalString(request.query[BOOTSTRAP_API_QUERY_PARAM.Slug]),
            verificationTokenIds: optionalStringList(
                request.query[BOOTSTRAP_API_QUERY_PARAM.VerificationTokenId],
            ),
        };
    }
}

function optionalStringList(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => {
        if (typeof item !== "string" || !item.trim()) {
            throw new ReadModelBadRequestError(
                "query value must be a non-empty string",
            );
        }
        return item.trim();
    });
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError("query value must be a string");
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
