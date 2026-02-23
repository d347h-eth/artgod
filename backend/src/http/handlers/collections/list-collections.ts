import type { FastifyRequest } from "fastify";
import type {
    ListCollectionsInput,
    ListCollectionsOutput,
} from "../../../application/use-cases/collections/list-collections.js";
import {
    getSearchParams,
    parseCursor,
    parseLimit,
    parseStatus,
} from "../../common/request-query.js";

export type ListCollectionsRoute = {
    Params: {
        chain_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ListCollectionsHttpAdapter {
    constructor(
        readonly listCollectionsPort: {
            listCollections(
                input: ListCollectionsInput,
            ): MaybePromise<ListCollectionsOutput>;
        },
    ) {}

    readonly handle = async (request: FastifyRequest<ListCollectionsRoute>) => {
        const input = this.mapRequestToInput(request);
        const output = await this.listCollectionsPort.listCollections(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<ListCollectionsRoute>,
    ): ListCollectionsInput {
        const searchParams = getSearchParams(request);
        const status = parseStatus(searchParams.get("status"));
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));

        return {
            chainRef: request.params.chain_ref,
            status,
            limit,
            cursor: cursor ?? undefined,
        };
    }

    private mapOutputToResponse(
        output: ListCollectionsOutput,
    ): ListCollectionsOutput {
        return output;
    }
}
