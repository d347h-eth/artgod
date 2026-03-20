import type { FastifyRequest } from "fastify";
import type {
    GetTokenActivityInput,
    GetTokenActivityOutput,
} from "../../../application/use-cases/activities/get-token-activity.js";
import {
    getSearchParams,
    parseCursor,
    parseLimit,
} from "../../common/request-query.js";

export type GetTokenActivityRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        token_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetTokenActivityHttpAdapter {
    constructor(
        readonly getTokenActivityPort: {
            getTokenActivity(
                input: GetTokenActivityInput,
            ): MaybePromise<GetTokenActivityOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetTokenActivityRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output = await this.getTokenActivityPort.getTokenActivity(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetTokenActivityRoute>,
    ): GetTokenActivityInput {
        const searchParams = getSearchParams(request);
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenRef: request.params.token_ref,
            limit,
            cursor: cursor ?? undefined,
        };
    }

    private mapOutputToResponse(
        output: GetTokenActivityOutput,
    ): GetTokenActivityOutput {
        return output;
    }
}
