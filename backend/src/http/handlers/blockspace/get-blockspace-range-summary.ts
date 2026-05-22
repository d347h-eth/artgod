import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    GetSyncBackfillRangeSummaryInput,
    GetSyncBackfillRangeSummaryOutput,
    GetSyncBackfillStateUseCase,
} from "../../../application/use-cases/sync-backfill/get-sync-backfill-state.js";
import {
    getSearchParams,
    parseOptionalInteger,
} from "../../common/request-query.js";

export type GetBlockspaceRangeSummaryRoute = {
    Params: {
        chain_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetBlockspaceRangeSummaryHttpAdapter {
    constructor(
        private readonly getBlockspaceRangeSummaryPort:
            | {
                  getRangeSummary(
                      input: GetSyncBackfillRangeSummaryInput,
                  ): MaybePromise<GetSyncBackfillRangeSummaryOutput>;
              }
            | GetSyncBackfillStateUseCase,
        private readonly fixedCollectionRef: string | null = null,
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetBlockspaceRangeSummaryRoute>,
    ) => {
        const searchParams = getSearchParams(request);
        const collectionRef =
            this.fixedCollectionRef ?? searchParams.get("collection");
        return this.getBlockspaceRangeSummaryPort.getRangeSummary({
            chainRef: request.params.chain_ref,
            collectionRef,
            fromBlock: parseRequiredInteger(searchParams, "from_block"),
            toBlock: parseRequiredInteger(searchParams, "to_block"),
        });
    };
}

function parseRequiredInteger(
    searchParams: URLSearchParams,
    field: string,
): number {
    const parsed = parseOptionalInteger(searchParams.get(field), field);
    if (parsed === null) {
        throw new ReadModelBadRequestError(`${field} is required`);
    }
    return parsed;
}
