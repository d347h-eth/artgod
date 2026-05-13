import type { FastifyRequest } from "fastify";
import type {
    PreviewBiddingPriceTierReapplyInput,
    PreviewBiddingPriceTierReapplyOutput,
} from "../../../application/use-cases/trading/preview-bidding-price-tier-reapply.js";

export type PreviewBiddingPriceTierReapplyRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        tier_id: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class PreviewBiddingPriceTierReapplyHttpAdapter {
    constructor(
        readonly previewBiddingPriceTierReapplyPort: {
            previewBiddingPriceTierReapply(
                input: PreviewBiddingPriceTierReapplyInput,
            ): MaybePromise<PreviewBiddingPriceTierReapplyOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<PreviewBiddingPriceTierReapplyRoute>,
    ) => {
        return await this.previewBiddingPriceTierReapplyPort.previewBiddingPriceTierReapply(
            {
                chainRef: request.params.chain_ref,
                collectionRef: request.params.collection_ref,
                tierId: request.params.tier_id,
            },
        );
    };
}
