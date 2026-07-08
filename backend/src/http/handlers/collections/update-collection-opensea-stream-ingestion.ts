import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import { isOpenSeaStreamIngestionStatus } from "@artgod/shared/types";
import type {
    UpdateOpenSeaStreamIngestionInput,
    UpdateOpenSeaStreamIngestionOutput,
} from "../../../application/use-cases/collections/update-opensea-stream-ingestion.js";

export type UpdateCollectionOpenSeaStreamIngestionRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Body: {
        status?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class UpdateCollectionOpenSeaStreamIngestionHttpAdapter {
    constructor(
        private readonly updateOpenSeaStreamIngestionPort: {
            update(
                input: UpdateOpenSeaStreamIngestionInput,
            ): MaybePromise<UpdateOpenSeaStreamIngestionOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<UpdateCollectionOpenSeaStreamIngestionRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return await this.updateOpenSeaStreamIngestionPort.update(input);
    };

    private mapRequestToInput(
        request: FastifyRequest<UpdateCollectionOpenSeaStreamIngestionRoute>,
    ): UpdateOpenSeaStreamIngestionInput {
        const body = request.body ?? {};
        if (
            typeof body.status !== "string" ||
            !isOpenSeaStreamIngestionStatus(body.status)
        ) {
            throw new ReadModelBadRequestError(
                "Invalid OpenSea stream ingestion status",
            );
        }

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            status: body.status,
        };
    }
}
