import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    PurgeCollectionInput,
    PurgeCollectionOutput,
} from "../../../application/use-cases/collections/purge-collection.js";

export type PurgeCollectionRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Body: {
        confirmation?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class PurgeCollectionHttpAdapter {
    constructor(
        readonly purgeCollectionPort: {
            purgeCollection(
                input: PurgeCollectionInput,
            ): MaybePromise<PurgeCollectionOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<PurgeCollectionRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return await this.purgeCollectionPort.purgeCollection(input);
    };

    private mapRequestToInput(
        request: FastifyRequest<PurgeCollectionRoute>,
    ): PurgeCollectionInput {
        const body = request.body ?? {};
        if (typeof body.confirmation !== "string") {
            throw new ReadModelBadRequestError("confirmation is required");
        }

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            confirmation: body.confirmation,
        };
    }
}
