import type { FastifyRequest } from "fastify";
import type { RetryBootstrapRunFailedTasksOutput } from "../../../application/use-cases/bootstrap/retry-bootstrap-run-failed-tasks.js";
import { parseBootstrapRunId } from "./request-parsing.js";

export type RetryBootstrapRunFailedTasksRoute = {
    Params: {
        chain_ref: string;
        run_id: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class RetryBootstrapRunFailedTasksHttpAdapter {
    constructor(
        private readonly retryBootstrapRunFailedTasksPort: {
            retryFailedTasks(input: {
                chainRef: string;
                runId: number;
            }): MaybePromise<RetryBootstrapRunFailedTasksOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<RetryBootstrapRunFailedTasksRoute>,
    ) => {
        return this.retryBootstrapRunFailedTasksPort.retryFailedTasks({
            chainRef: request.params.chain_ref,
            runId: parseBootstrapRunId(request.params.run_id),
        });
    };
}
