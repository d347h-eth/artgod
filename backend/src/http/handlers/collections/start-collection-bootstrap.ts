import type { FastifyRequest } from "fastify";
import type {
    StartPreparedCollectionBootstrapInput,
} from "../../../application/use-cases/bootstrap/start-prepared-collection-bootstrap.js";
import type { CreateBootstrapRunOutput } from "../../../application/use-cases/bootstrap/types.js";

export type StartCollectionBootstrapRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class StartCollectionBootstrapHttpAdapter {
    constructor(
        private readonly startCollectionBootstrapPort: {
            startBootstrap(
                input: StartPreparedCollectionBootstrapInput,
            ): MaybePromise<CreateBootstrapRunOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<StartCollectionBootstrapRoute>,
    ) => {
        return this.startCollectionBootstrapPort.startBootstrap({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
        });
    };
}
