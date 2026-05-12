import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import { TRADING_JOB_STATUS } from "@artgod/shared/types";
import type { BiddingPriceTiersRepositoryPort } from "./bidding-price-tier-ports.js";
import {
    mapResolvedBiddingPriceTierToView,
    resolveBiddingPriceTierGraph,
    type BiddingPriceTierView,
} from "./bidding-price-tiers.js";
import { TradingValidationError } from "./types.js";

export type ArchiveCollectionBiddingPriceTierInput = {
    chainRef: string;
    collectionRef: string;
    tierId: string;
};

export type ArchiveCollectionBiddingPriceTierOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tier: BiddingPriceTierView;
    tiers: BiddingPriceTierView[];
};

export class ArchiveCollectionBiddingPriceTierUseCase {
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
        },
        readonly biddingPriceTiersRepositoryPort: Pick<
            BiddingPriceTiersRepositoryPort,
            | "listCollectionPriceTiers"
            | "getPriceTierById"
            | "archivePriceTier"
            | "updatePriceTierResolutions"
        >,
    ) {}

    archiveCollectionBiddingPriceTier(
        input: ArchiveCollectionBiddingPriceTierInput,
    ): ArchiveCollectionBiddingPriceTierOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before mutating its price tier graph.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Load active tiers to reject archiving a parent that still has an active child.
        const activeTiers =
            this.biddingPriceTiersRepositoryPort.listCollectionPriceTiers({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
        const existing =
            this.biddingPriceTiersRepositoryPort.getPriceTierById(input.tierId);
        if (!existing || existing.collectionId !== collection.collectionId) {
            throw new TradingValidationError("price tier was not found");
        }
        if (activeTiers.some((tier) => tier.parentTierId === input.tierId)) {
            throw new TradingValidationError(
                "Cannot archive a price tier that still has an active child",
            );
        }

        // Archive the tier without mutating any market-side job commands.
        const archived =
            this.biddingPriceTiersRepositoryPort.archivePriceTier(input.tierId);
        if (!archived) {
            throw new TradingValidationError("price tier was not found");
        }
        const remainingGraph = resolveBiddingPriceTierGraph(
            activeTiers.filter((tier) => tier.tierId !== input.tierId),
        );
        // Refresh scalar cache columns for the remaining active graph after archive.
        this.biddingPriceTiersRepositoryPort.updatePriceTierResolutions(
            remainingGraph.map((tier) => ({
                tierId: tier.tierId,
                resolvedFloorWei: tier.resolvedFloorWei,
                resolvedCeilingWei: tier.resolvedCeilingWei,
                resolvedAt: tier.resolvedAt,
                lastError: null,
            })),
        );

        return {
            chain,
            collection,
            tier: {
                tierId: archived.tierId,
                name: archived.name,
                status: TRADING_JOB_STATUS.Archived,
                sortOrder: archived.sortOrder,
                parentTierId: archived.parentTierId,
                floorConfig: archived.floorConfig,
                ceilingConfig: archived.ceilingConfig,
                resolvedFloorEth: null,
                resolvedCeilingEth: null,
                resolvedAt: archived.resolvedAt,
                lastError: archived.lastError,
                revision: archived.revision,
                createdAt: archived.createdAt,
                updatedAt: archived.updatedAt,
                archivedAt: archived.archivedAt,
            },
            tiers: remainingGraph.map((tier) =>
                mapResolvedBiddingPriceTierToView(tier),
            ),
        };
    }
}
