import {
    TRADING_JOB_TARGET_KIND,
    type ChainRecord,
    type CollectionListItem,
    type TradingBiddingJobTargetDescriptor,
    type TradingTraitCriterion,
    normalizeTradingTraitCriteria,
} from "@artgod/shared/types";
import type { BiddingJobsRepositoryPort } from "./ports.js";
import type { BiddingJobView } from "./types.js";
import {
    TradingValidationError,
    mapPersistedBiddingJobToView,
} from "./types.js";

export type BiddingJobTargetLookupRequestTarget =
    | {
          type: "token";
          tokenId: string;
      }
    | {
          type: "collection";
          quantity?: number;
      }
    | {
          type: "trait";
          quantity?: number;
          targetTraits: TradingTraitCriterion[];
      };

export type BiddingJobTargetLookupInput = {
    chainRef: string;
    collectionRef: string;
    target: BiddingJobTargetLookupRequestTarget;
};

export type BiddingJobTargetLookupOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    job: BiddingJobView | null;
};

// BiddingJobTargetLookupUseCase resolves whether a declared target already has a live job.
export class BiddingJobTargetLookupUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionReadPort: {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
            getCollectionTokenDetail(params: {
                chainId: number;
                collectionId: number;
                tokenId: string;
            }): { tokenId: string };
        },
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "findJobByTarget"
        >,
    ) {}

    lookupBiddingJobTarget(
        input: BiddingJobTargetLookupInput,
    ): BiddingJobTargetLookupOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before comparing its declared bidding targets.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        const target = this.mapTarget(
            chain.publicChainId,
            collection.collectionId,
            input.target,
        );

        // Look up the active declared job using canonical target-equivalence rules.
        const job = this.biddingJobsRepositoryPort.findJobByTarget({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            target,
        });

        return {
            chain,
            collection,
            job: job ? mapPersistedBiddingJobToView(job) : null,
        };
    }

    private mapTarget(
        chainId: number,
        collectionId: number,
        target: BiddingJobTargetLookupRequestTarget,
    ): TradingBiddingJobTargetDescriptor {
        if (target.type === "token") {
            const tokenId = parseRequiredString(target.tokenId, "target.tokenId");
            // Verify the token exists before resolving its declared job target.
            const token = this.collectionReadPort.getCollectionTokenDetail({
                chainId,
                collectionId,
                tokenId,
            });
            return {
                targetKind: TRADING_JOB_TARGET_KIND.Token,
                tokenId: token.tokenId,
            };
        }

        if (target.type === "collection") {
            return {
                targetKind: TRADING_JOB_TARGET_KIND.Collection,
                quantity: parseQuantity(target.quantity),
                targetTraits: [],
            };
        }

        return {
            targetKind: TRADING_JOB_TARGET_KIND.Collection,
            quantity: parseQuantity(target.quantity),
            targetTraits: parseTargetTraits(target.targetTraits),
        };
    }
}

function parseQuantity(value: number | undefined): number {
    if (value === undefined) {
        return 1;
    }
    if (!Number.isInteger(value) || value <= 0) {
        throw new TradingValidationError("target.quantity must be an integer > 0");
    }
    return value;
}

function parseTargetTraits(
    value: TradingTraitCriterion[],
): TradingTraitCriterion[] {
    if (value.length === 0) {
        throw new TradingValidationError("target.targetTraits is required");
    }

    const seen = new Set<string>();
    return normalizeTradingTraitCriteria(value).map((trait) => {
        if (!trait.type || !trait.value) {
            throw new TradingValidationError(
                "target.targetTraits entries require type and value",
            );
        }
        const key = `${trait.type}\u0000${trait.value}`;
        if (seen.has(key)) {
            throw new TradingValidationError(
                `duplicate target trait ${trait.type}=${trait.value}`,
            );
        }
        seen.add(key);
        return trait;
    });
}

function parseRequiredString(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized) {
        throw new TradingValidationError(`${field} is required`);
    }
    return normalized;
}
