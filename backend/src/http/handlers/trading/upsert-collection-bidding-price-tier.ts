import type { FastifyRequest } from "fastify";
import type {
    UpsertCollectionBiddingPriceTierInput,
    UpsertCollectionBiddingPriceTierOutput,
} from "../../../application/use-cases/trading/upsert-collection-bidding-price-tier.js";
import { parsePriceTierBody } from "./bidding-price-tier-http.js";

export type UpsertCollectionBiddingPriceTierRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Body: {
        tierId?: unknown;
        name?: unknown;
        status?: unknown;
        sortOrder?: unknown;
        parentTierId?: unknown;
        floorConfig?: unknown;
        ceilingConfig?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class UpsertCollectionBiddingPriceTierHttpAdapter {
    constructor(
        readonly upsertCollectionBiddingPriceTierPort: {
            upsertCollectionBiddingPriceTier(
                input: UpsertCollectionBiddingPriceTierInput,
            ): MaybePromise<UpsertCollectionBiddingPriceTierOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<UpsertCollectionBiddingPriceTierRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return await this.upsertCollectionBiddingPriceTierPort.upsertCollectionBiddingPriceTier(
            input,
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<UpsertCollectionBiddingPriceTierRoute>,
    ): UpsertCollectionBiddingPriceTierInput {
        const body = parsePriceTierBody(request.body ?? {});
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            ...body,
        };
    }
}
