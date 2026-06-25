import { BidderJob } from "../../../domain/market/strategy/job.js";

export type OfferScope = "item" | "collection" | "trait" | "unknown";
export type OfferDiscoverySource =
    | "itemOffers"
    | "collectionOffers"
    | "traitOffers"
    | "bestOffer"
    | "stateRecovery"
    | "unknown";

// Order is the adapter boundary model the bidder reasons over.
export interface Order {
    id: string;
    price: bigint;
    maker: string;
    protocolAddress?: string;
    placedAt?: string;
    expirationTime?: number;
    rawOrder?: unknown;
    offerScope?: OfferScope;
    discoverySource?: OfferDiscoverySource;
    priceSource?: string;
    source?: string;
    quantity?: bigint;
}

export interface BiddingService {
    getActiveOffers(job: BidderJob): Promise<Order[]>;
    getActiveTokenOfferByMaker(
        job: BidderJob,
        makerAddress: string,
    ): Promise<Order | null>;
    getOrder(
        orderHash: string,
        protocolAddress?: string,
        collectionAddress?: string,
        tokenId?: string,
        collectionSlug?: string,
    ): Promise<Order | null>;
    placeOffer(
        job: BidderJob,
        amount: bigint,
    ): Promise<{
        orderHash: string;
        protocolAddress: string;
        placedAt: string;
        expirationTime?: number;
    }>;
    cancelOffer(job: BidderJob, order: Order): Promise<void>;
}
