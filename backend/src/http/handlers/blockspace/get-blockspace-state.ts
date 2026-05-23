import type { FastifyRequest } from "fastify";
import { BLOCKSPACE_QUERY_PARAMS } from "@artgod/shared/config/blockspace";
import type {
    GetSyncBackfillStateInput,
    GetSyncBackfillStateOutput,
    GetSyncBackfillStateUseCase,
} from "../../../application/use-cases/sync-backfill/get-sync-backfill-state.js";
import {
    getSearchParams,
    parseOptionalInteger,
} from "../../common/request-query.js";

export type GetBlockspaceStateRoute = {
    Params: {
        chain_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetBlockspaceStateHttpAdapter {
    constructor(
        private readonly getBlockspaceStatePort:
            | {
                  getState(
                      input: GetSyncBackfillStateInput,
                  ): MaybePromise<GetSyncBackfillStateOutput>;
              }
            | GetSyncBackfillStateUseCase,
        private readonly fixedCollectionRef: string | null = null,
        private readonly collectionOptions: "all" | "selected" = "all",
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetBlockspaceStateRoute>,
    ) => {
        const searchParams = getSearchParams(request);
        const collectionRef =
            this.fixedCollectionRef ??
            searchParams.get(BLOCKSPACE_QUERY_PARAMS.Collection);
        return this.getBlockspaceStatePort.getState({
            chainRef: request.params.chain_ref,
            collectionRef,
            pageStartBlock: parseOptionalInteger(
                searchParams.get(BLOCKSPACE_QUERY_PARAMS.PageStart),
                BLOCKSPACE_QUERY_PARAMS.PageStart,
            ),
            bucketSize: parseOptionalInteger(
                searchParams.get(BLOCKSPACE_QUERY_PARAMS.BucketSize),
                BLOCKSPACE_QUERY_PARAMS.BucketSize,
            ),
            collectionOptions: this.collectionOptions,
        });
    };
}
