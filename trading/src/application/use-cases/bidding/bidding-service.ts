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

// Cancellation needs a saved identity, never an executable offer or current price.
// Optional historical metadata is retained for cancellation records.
export type OrderCancellation = Pick<
    Order,
    "id" | "protocolAddress" | "placedAt" | "expirationTime"
> & { price?: bigint };

// BiddingOrderRecoveryStatus is the order lookup proof state used for cancellation safety.
export const BIDDING_ORDER_RECOVERY_STATUS = {
    Active: "active",
    Terminal: "terminal",
    Inconclusive: "inconclusive",
} as const;

export type BiddingOrderRecoveryStatus =
    (typeof BIDDING_ORDER_RECOVERY_STATUS)[keyof typeof BIDDING_ORDER_RECOVERY_STATUS];

// BiddingOrderRecoveryReason names adapter proof failures that keep cancellation retryable.
export const BIDDING_ORDER_RECOVERY_REASON = {
    DirectLookupFailed: "direct_lookup_failed",
    LookupUnavailable: "lookup_unavailable",
    ParseFailed: "parse_failed",
    NotActive: "not_active",
} as const;

export type BiddingOrderRecoveryReason =
    (typeof BIDDING_ORDER_RECOVERY_REASON)[keyof typeof BIDDING_ORDER_RECOVERY_REASON];

export type BiddingOrderRecoveryResult =
    | {
          status: typeof BIDDING_ORDER_RECOVERY_STATUS.Active;
          order: Order;
      }
    | {
          status: typeof BIDDING_ORDER_RECOVERY_STATUS.Terminal;
      }
    | {
          status: typeof BIDDING_ORDER_RECOVERY_STATUS.Inconclusive;
          reason: BiddingOrderRecoveryReason;
      };

export interface BiddingService {
    // Marketplace price rules apply before strategy comparisons and order tracking.
    // Rounding down returns zero when no positive offer fits the amount.
    roundOfferPriceDown(amount: bigint): bigint;
    // Preserve zero; positive amounts round to the next accepted unit price.
    roundOfferPriceUp(amount: bigint): bigint;
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
    ): Promise<BiddingOrderRecoveryResult>;
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
        order: OrderCancellation,
        context?: BiddingServiceRequestContext,
    ): Promise<void>;
    // Cancels a recovered order when no active job declaration should be rehydrated.
    cancelRecoveredOrder(
        order: OrderCancellation,
        context?: BiddingServiceRequestContext,
    ): Promise<void>;
}
