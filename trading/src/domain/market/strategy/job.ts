export interface BidderConfig {
    ceiling: bigint;
    floor: bigint;
    delta: bigint;
}

export interface BidderState {
    lastRun?: number;
    activeOrderId?: string;
    activeProtocolAddress?: string;
    currentPrice?: bigint;
    activeExpirationTimeMs?: number;
}

export interface TraitSelector {
    type: string;
    value?: string;
}

export interface TraitTarget {
    type: string;
    value: string;
}

export type BidderTarget =
    | {
          type: "token";
          tokenId: string;
      }
    | {
          type: "collection";
          quantity: number;
          traits?: TraitTarget[];
      }
    | {
          type: "competitiveTrait";
          quantity: number;
          targetTrait: TraitTarget;
          competitorTraits: TraitSelector[];
      };

// BidderJob is the stable business object carried between the pure bidding core and adapters.
export interface BidderJob {
    id: string;
    network: "eth";
    collectionAddress: string;
    collectionSlug: string;
    target: BidderTarget;
    config: BidderConfig;
    state: BidderState;
}
