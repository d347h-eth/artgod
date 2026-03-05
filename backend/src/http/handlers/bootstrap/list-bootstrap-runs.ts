import type { FastifyRequest } from "fastify";
import type {
    ListBootstrapRunsInput,
    ListBootstrapRunsUseCase,
} from "../../../application/use-cases/bootstrap/list-bootstrap-runs.js";
import type { ListBootstrapRunsOutput } from "../../../application/use-cases/bootstrap/types.js";
import {
    getSearchParams,
    parseBootstrapRunStatus,
    parseCursor,
    parseLimit,
} from "../../common/request-query.js";

export type ListBootstrapRunsRoute = {
    Params: {
        chain_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ListBootstrapRunsHttpAdapter {
    constructor(
        private readonly listBootstrapRunsPort:
            | {
                  listRuns(
                      input: ListBootstrapRunsInput,
                  ): MaybePromise<ListBootstrapRunsOutput>;
              }
            | ListBootstrapRunsUseCase,
    ) {}

    readonly handle = async (
        request: FastifyRequest<ListBootstrapRunsRoute>,
    ) => {
        const searchParams = getSearchParams(request);
        const status = parseBootstrapRunStatus(searchParams.get("status"));
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));
        return this.listBootstrapRunsPort.listRuns({
            chainRef: request.params.chain_ref,
            status,
            limit,
            cursor: cursor ?? undefined,
        });
    };
}
