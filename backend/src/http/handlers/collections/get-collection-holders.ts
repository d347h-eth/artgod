import type { FastifyRequest } from "fastify";
import type {
    GetCollectionHoldersInput,
    GetCollectionHoldersOutput,
} from "../../../application/use-cases/collections/get-collection-holders.js";
import {
    getSearchParams,
    parseCursor,
    parseLimit,
} from "../../common/request-query.js";

export type GetCollectionHoldersRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetCollectionHoldersHttpAdapter {
    constructor(
        readonly getCollectionHoldersPort: {
            getCollectionHolders(
                input: GetCollectionHoldersInput,
            ): MaybePromise<GetCollectionHoldersOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetCollectionHoldersRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output =
            await this.getCollectionHoldersPort.getCollectionHolders(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetCollectionHoldersRoute>,
    ): GetCollectionHoldersInput {
        const searchParams = getSearchParams(request);
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            limit,
            cursor: cursor ?? undefined,
        };
    }

    private mapOutputToResponse(
        output: GetCollectionHoldersOutput,
    ): GetCollectionHoldersOutput {
        return output;
    }
}
