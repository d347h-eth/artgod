import type {
    TradingBiddingJobRuntimeBidPosition,
    TradingBiddingJobRuntimeConstraint,
} from "@artgod/shared/types";

export interface BidderConfig {
    ceiling: bigint;
    floor: bigint;
    delta: bigint;
}

export interface BidderState {
    lastRun?: number;
    activeOrderId?: string;
    activeProtocolAddress?: string;
    activeOrderPlacedAt?: string;
    currentPrice?: bigint;
    activeExpirationTimeMs?: number;
    bidPosition?: TradingBiddingJobRuntimeBidPosition;
    bidConstraints?: TradingBiddingJobRuntimeConstraint[];
    competitorPrice?: bigint;
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

const MAX_LOG_TRAITS = 6;
const MAX_LOG_VALUE_LENGTH = 96;

// Format the job around its human target first while preserving the durable job id.
export function formatBidderJobReference(job: BidderJob): string {
    return `${job.collectionSlug}/${formatBidderTargetReference(job.target)} (jobId=${job.id})`;
}

function formatBidderTargetReference(target: BidderTarget): string {
    if (target.type === "token") {
        return `token#${target.tokenId}`;
    }

    if (target.type === "collection") {
        const traits = target.traits ?? [];
        const scope =
            traits.length > 0
                ? `traits[${formatTraitTargets(traits)}]`
                : "collection";
        return `${scope} qty=${formatQuantity(target.quantity)}`;
    }

    return `competitive[target=${formatTraitTarget(target.targetTrait)}; competitors=${formatTraitSelectors(target.competitorTraits)}; qty=${formatQuantity(target.quantity)}]`;
}

function formatTraitTargets(traits: TraitTarget[]): string {
    return formatLimitedList(traits.map(formatTraitTarget));
}

function formatTraitSelectors(traits: TraitSelector[]): string {
    return traits.length > 0
        ? formatLimitedList(traits.map(formatTraitSelector))
        : "none";
}

function formatTraitTarget(trait: TraitTarget): string {
    return `${compactLogValue(trait.type)}=${compactLogValue(trait.value)}`;
}

function formatTraitSelector(trait: TraitSelector): string {
    return trait.value === undefined
        ? `${compactLogValue(trait.type)}=*`
        : `${compactLogValue(trait.type)}=${compactLogValue(trait.value)}`;
}

function formatLimitedList(values: string[]): string {
    const visible = values.slice(0, MAX_LOG_TRAITS);
    const remaining = values.length - visible.length;
    return remaining > 0
        ? `${visible.join("|")}|+${remaining} more`
        : visible.join("|");
}

function formatQuantity(value: number): string {
    return Number.isFinite(value)
        ? String(Math.max(1, Math.floor(value)))
        : "1";
}

function compactLogValue(value: string): string {
    return value.length > MAX_LOG_VALUE_LENGTH
        ? `${value.slice(0, MAX_LOG_VALUE_LENGTH - 3)}...`
        : value;
}
