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
        private readonly fixedCollectionRef: string | null = null,
        private readonly collectionOptions: "all" | "selected" = "all",
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetSyncBackfillStateRoute>,
    ) => {
        const searchParams = getSearchParams(request);
        const collectionRef =
            this.fixedCollectionRef ?? searchParams.get("collection");
        return this.getSyncBackfillStatePort.getState({
            chainRef: request.params.chain_ref,
            collectionRef,
            pageStartBlock: parseOptionalInteger(
                searchParams.get("page_start"),
                "page_start",
            ),
            bucketSize: parseOptionalInteger(
                searchParams.get("bucket_size"),
                "bucket_size",
            ),
            collectionOptions: this.collectionOptions,
        });
    };
}
