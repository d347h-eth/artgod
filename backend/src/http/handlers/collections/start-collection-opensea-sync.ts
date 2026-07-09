import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    StartOpenSeaCollectionSyncInput,
    StartOpenSeaCollectionSyncOutput,
} from "../../../application/use-cases/collections/start-opensea-collection-sync.js";

export type StartCollectionOpenSeaSyncRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Body: {
        openseaSlug: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

// Wire field accepted by the OpenSea sync start route body.
const OPENSEA_SYNC_OPENSEA_SLUG_BODY_FIELD = "openseaSlug";

export class StartCollectionOpenSeaSyncHttpAdapter {
    constructor(
        private readonly startCollectionOpenSeaSyncPort: {
            startSync(
                input: StartOpenSeaCollectionSyncInput,
            ): MaybePromise<StartOpenSeaCollectionSyncOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<StartCollectionOpenSeaSyncRoute>,
    ) => {
        return this.startCollectionOpenSeaSyncPort.startSync({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            openseaSlug: requiredString(
                request.body?.[OPENSEA_SYNC_OPENSEA_SLUG_BODY_FIELD],
            ),
        });
    };
}

function requiredString(value: unknown): string {
    if (value === undefined || value === null) {
        throw new ReadModelBadRequestError(
            `${OPENSEA_SYNC_OPENSEA_SLUG_BODY_FIELD} is required`,
        );
    }
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError(
            `${OPENSEA_SYNC_OPENSEA_SLUG_BODY_FIELD} must be a string`,
        );
    }
    const trimmed = value.trim();
    if (!trimmed) {
        throw new ReadModelBadRequestError(
            `${OPENSEA_SYNC_OPENSEA_SLUG_BODY_FIELD} is required`,
        );
    }
    return trimmed;
}
