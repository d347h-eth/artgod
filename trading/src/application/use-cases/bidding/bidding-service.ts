import { BidderJob } from "../../../domain/market/strategy/job.js";

export type OfferScope = "item" | "collection" | "trait" | "unknown";
export type OfferDiscoverySource =
    | "itemOffers"
    | "collectionOffers"
    | "traitOffers"
    | "bestOffer"
    | "stateRecovery"
    | "unknown";

// Request priorities let durable user commands outrank background hot-refresh reads at adapter bottlenecks.
export const BIDDING_SERVICE_REQUEST_PRIORITY = {
    Background: "background",
    UserCommand: "user_command",
} as const;

export type BiddingServiceRequestPriority =
    (typeof BIDDING_SERVICE_REQUEST_PRIORITY)[keyof typeof BIDDING_SERVICE_REQUEST_PRIORITY];

export type BiddingServiceRequestContext = {
    priority?: BiddingServiceRequestPriority;
};

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
    getActiveOffers(
        job: BidderJob,
        context?: BiddingServiceRequestContext,
    ): Promise<Order[]>;
    getActiveTokenOfferByMaker(
        job: BidderJob,
        makerAddress: string,
        context?: BiddingServiceRequestContext,
    ): Promise<Order | null>;
    getOrder(
        orderHash: string,
        protocolAddress?: string,
        collectionAddress?: string,
        tokenId?: string,
        collectionSlug?: string,
        context?: BiddingServiceRequestContext,
    ): Promise<Order | null>;
    placeOffer(
        job: BidderJob,
        amount: bigint,
        context?: BiddingServiceRequestContext,
    ): Promise<{
        orderHash: string;
        protocolAddress: string;
        placedAt: string;
        expirationTime?: number;
    }>;
    cancelOffer(
        job: BidderJob,
        order: Order,
        context?: BiddingServiceRequestContext,
    ): Promise<void>;
}
