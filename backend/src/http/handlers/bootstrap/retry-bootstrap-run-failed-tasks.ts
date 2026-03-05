import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type { RetryBootstrapRunFailedTasksOutput } from "../../../application/use-cases/bootstrap/retry-bootstrap-run-failed-tasks.js";

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
            runId: parseRunId(request.params.run_id),
        });
    };
}

function parseRunId(raw: string): number {
    const value = raw.trim();
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ReadModelBadRequestError("Invalid run_id");
    }
    return parsed;
}
