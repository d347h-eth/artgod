import type { FastifyRequest } from "fastify";
import { COLLECTION_API_QUERY_PARAM } from "@artgod/shared/http/collection-routes";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    ProbeCollectionOpenSeaSlugInput,
    ProbeCollectionOpenSeaSlugOutput,
} from "../../../application/use-cases/collections/start-opensea-collection-sync.js";

export type ProbeCollectionOpenSeaSlugRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Querystring: {
        slug?: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ProbeCollectionOpenSeaSlugHttpAdapter {
    constructor(
        private readonly probeCollectionOpenSeaSlugPort: {
            probeSlug(
                input: ProbeCollectionOpenSeaSlugInput,
            ): MaybePromise<ProbeCollectionOpenSeaSlugOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ProbeCollectionOpenSeaSlugRoute>,
    ) => {
        return this.probeCollectionOpenSeaSlugPort.probeSlug({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            slug: optionalString(
                request.query[COLLECTION_API_QUERY_PARAM.OpenSeaSlug],
            ),
        });
    };
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError("query value must be a string");
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}
