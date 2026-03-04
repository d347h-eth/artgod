import type { FastifyRequest } from "fastify";
import type { ListBootstrapMetadataTasksOutput } from "../../../application/use-cases/bootstrap/list-bootstrap-metadata-tasks.js";
import {
    getSearchParams,
    parseBootstrapTaskStatus,
    parseCursor,
    parseLimit,
} from "../../common/request-query.js";

export type ListBootstrapMetadataTasksRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ListBootstrapMetadataTasksHttpAdapter {
    constructor(
        private readonly listBootstrapMetadataTasksPort: {
            listTasks(input: {
                chainRef: string;
                collectionRef: string;
                status?: "pending" | "retry" | "succeeded" | "failed_terminal";
                limit: number;
                cursor?: string;
            }): MaybePromise<ListBootstrapMetadataTasksOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ListBootstrapMetadataTasksRoute>,
    ) => {
        const searchParams = getSearchParams(request);
        const status = parseBootstrapTaskStatus(searchParams.get("status"));
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));
        return this.listBootstrapMetadataTasksPort.listTasks({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            status,
            limit,
            cursor: cursor ?? undefined,
        });
    };
}
