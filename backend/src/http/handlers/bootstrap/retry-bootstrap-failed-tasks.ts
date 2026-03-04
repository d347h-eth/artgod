import type { FastifyRequest } from "fastify";
import type { RetryBootstrapFailedTasksOutput } from "../../../application/use-cases/bootstrap/retry-bootstrap-failed-tasks.js";

export type RetryBootstrapFailedTasksRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class RetryBootstrapFailedTasksHttpAdapter {
    constructor(
        private readonly retryBootstrapFailedTasksPort: {
            retryFailedTasks(input: {
                chainRef: string;
                collectionRef: string;
            }): MaybePromise<RetryBootstrapFailedTasksOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<RetryBootstrapFailedTasksRoute>,
    ) => {
        return this.retryBootstrapFailedTasksPort.retryFailedTasks({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
        });
    };
}
