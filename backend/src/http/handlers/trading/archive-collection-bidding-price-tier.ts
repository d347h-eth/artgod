import type { FastifyRequest } from "fastify";
import type {
    ArchiveCollectionBiddingPriceTierInput,
    ArchiveCollectionBiddingPriceTierOutput,
} from "../../../application/use-cases/trading/archive-collection-bidding-price-tier.js";

export type ArchiveCollectionBiddingPriceTierRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        tier_id: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ArchiveCollectionBiddingPriceTierHttpAdapter {
    constructor(
        readonly archiveCollectionBiddingPriceTierPort: {
            archiveCollectionBiddingPriceTier(
                input: ArchiveCollectionBiddingPriceTierInput,
            ): MaybePromise<ArchiveCollectionBiddingPriceTierOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ArchiveCollectionBiddingPriceTierRoute>,
    ) => {
        return await this.archiveCollectionBiddingPriceTierPort.archiveCollectionBiddingPriceTier(
            {
                chainRef: request.params.chain_ref,
                collectionRef: request.params.collection_ref,
                tierId: request.params.tier_id,
            },
        );
    };
}
