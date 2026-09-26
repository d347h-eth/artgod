import type { FastifyRequest } from "fastify";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";
import type { GetPriceChartContextPort } from "../../../application/use-cases/collections/get-price-chart-context.js";
import {
    getSearchParams,
    parseMediaPreference,
    parseTraits,
    parseTraitRanges,
} from "../../common/request-query.js";

export type GetPriceChartContextRoute = {
    Params: { chain_ref: string; collection_ref: string };
};
export class GetPriceChartContextHttpAdapter {
    constructor(private readonly context: GetPriceChartContextPort) {}
    readonly handle = async (
        request: FastifyRequest<GetPriceChartContextRoute>,
    ) => {
        const query = getSearchParams(request);
        return this.context.getPriceChartContext({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            traits: parseTraits(query),
            traitRanges: parseTraitRanges(query),
            mediaPreference: parseMediaPreference(
                query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference),
            ),
        });
    };
}
