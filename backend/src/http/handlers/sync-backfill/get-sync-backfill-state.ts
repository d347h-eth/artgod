import type { FastifyRequest } from "fastify";
import type {
    GetSyncBackfillStateInput,
    GetSyncBackfillStateOutput,
    GetSyncBackfillStateUseCase,
} from "../../../application/use-cases/sync-backfill/get-sync-backfill-state.js";
import {
    getSearchParams,
    parseOptionalInteger,
} from "../../common/request-query.js";

export type GetSyncBackfillStateRoute = {
    Params: {
        chain_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetSyncBackfillStateHttpAdapter {
    constructor(
        private readonly getSyncBackfillStatePort:
            | {
                  getState(
                      input: GetSyncBackfillStateInput,
                  ): MaybePromise<GetSyncBackfillStateOutput>;
              }
            | GetSyncBackfillStateUseCase,
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetSyncBackfillStateRoute>,
    ) => {
        const searchParams = getSearchParams(request);
        return this.getSyncBackfillStatePort.getState({
            chainRef: request.params.chain_ref,
            collectionRef: searchParams.get("collection"),
            fromBlock: parseOptionalInteger(
                searchParams.get("from_block"),
                "from_block",
            ),
            toBlock: parseOptionalInteger(
                searchParams.get("to_block"),
                "to_block",
            ),
        });
    };
}
