import type { FastifyRequest } from "fastify";
import type {
    StartOpenSeaCollectionSyncInput,
    StartOpenSeaCollectionSyncOutput,
} from "../../../application/use-cases/collections/start-opensea-collection-sync.js";

export type StartCollectionOpenSeaSyncRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

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
        });
    };
}
