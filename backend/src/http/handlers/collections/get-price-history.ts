import type { FastifyRequest } from "fastify";
import { PRICE_HISTORY_QUERY } from "@artgod/shared/http/collection-routes";
import type { GetPriceHistoryPort } from "../../../application/use-cases/collections/get-price-history.js";
import { getSearchParams } from "../../common/request-query.js";

export type GetPriceHistoryRoute = {
    Params: { chain_ref: string; collection_ref: string };
};
export class GetPriceHistoryHttpAdapter {
    constructor(private readonly prices: GetPriceHistoryPort) {}
    readonly handle = async (request: FastifyRequest<GetPriceHistoryRoute>) => {
        const query = getSearchParams(request);
        return this.prices.getPriceHistory({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            bucket: query.get(PRICE_HISTORY_QUERY.Bucket) ?? undefined,
            range: query.get(PRICE_HISTORY_QUERY.Range) ?? undefined,
            tokenId: query.get(PRICE_HISTORY_QUERY.TokenId) ?? undefined,
        });
    };
}
