import type {
    ChainRecord,
    CollectionListItem,
    TradingBiddingPriceTierCeilingConfig,
    TradingBiddingPriceTierFloorConfig,
    TradingBiddingPriceTierStatus,
} from "@artgod/shared/types";
import { TRADING_JOB_STATUS } from "@artgod/shared/types";
import type { BiddingPriceTiersRepositoryPort } from "./bidding-price-tier-ports.js";
import {
    comparePriceTierRecords,
    mapResolvedBiddingPriceTierToView,
    resolveBiddingPriceTierGraph,
    type BiddingPriceTierView,
} from "./bidding-price-tiers.js";
import { parsePositiveEthToWei, TradingValidationError } from "./types.js";

export type UpsertCollectionBiddingPriceTierInput = {
    chainRef: string;
    collectionRef: string;
    tierId?: string;
    name: string;
    status: Exclude<TradingBiddingPriceTierStatus, "archived">;
    sortOrder: number;
    parentTierId: string | null;
    floorConfig: TradingBiddingPriceTierFloorConfig;
    ceilingConfig: TradingBiddingPriceTierCeilingConfig;
    deltaEth: string;
};

export type UpsertCollectionBiddingPriceTierOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    tier: BiddingPriceTierView;
    tiers: BiddingPriceTierView[];
};

export class UpsertCollectionBiddingPriceTierUseCase {
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
            | "upsertPriceTier"
            | "updatePriceTierResolutions"
        >,
    ) {}

    upsertCollectionBiddingPriceTier(
        input: UpsertCollectionBiddingPriceTierInput,
    ): UpsertCollectionBiddingPriceTierOutput {
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
        const normalizedName = input.name.trim();
        if (!normalizedName) {
            throw new TradingValidationError("name is required");
        }
        if (!Number.isInteger(input.sortOrder)) {
            throw new TradingValidationError("sortOrder must be an integer");
        }
        const deltaWei = parsePositiveEthToWei(input.deltaEth, "deltaEth");

        // Load existing tiers so the candidate graph can be validated before writing.
        const existingTiers =
            this.biddingPriceTiersRepositoryPort.listCollectionPriceTiers({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                includeArchived: true,
            });
        const candidateTiers = existingTiers
            .filter((tier) => tier.tierId !== input.tierId)
            .filter((tier) => tier.status !== TRADING_JOB_STATUS.Archived);
        const candidate = {
            tierId: input.tierId ?? "__new_tier__",
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            name: normalizedName,
            status: input.status,
            sortOrder: input.sortOrder,
            parentTierId: input.parentTierId,
            floorConfig: input.floorConfig,
            ceilingConfig: input.ceilingConfig,
            deltaWei,
            resolvedFloorWei: null,
            resolvedCeilingWei: null,
            resolvedAt: null,
            lastError: null,
            revision: 1,
            createdAt: "",
            updatedAt: "",
            archivedAt: null,
        };
        const resolvedGraph = resolveBiddingPriceTierGraph([
            ...candidateTiers,
            candidate,
        ]);
        const resolvedCandidate = resolvedGraph.find(
            (tier) => tier.tierId === candidate.tierId,
        );
        if (!resolvedCandidate) {
            throw new TradingValidationError("price tier did not resolve");
        }

        // Persist the tier definition together with the scalar values resolved for the bot-facing model.
        const savedTier = this.biddingPriceTiersRepositoryPort.upsertPriceTier({
            tierId: input.tierId,
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            name: normalizedName,
            status: input.status,
            sortOrder: input.sortOrder,
            parentTierId: input.parentTierId,
            floorConfig: input.floorConfig,
            ceilingConfig: input.ceilingConfig,
            deltaWei,
            resolvedFloorWei: resolvedCandidate.resolvedFloorWei,
            resolvedCeilingWei: resolvedCandidate.resolvedCeilingWei,
            resolvedAt: resolvedCandidate.resolvedAt,
            lastError: null,
        });
        const persistedGraph = resolveBiddingPriceTierGraph([
            ...candidateTiers,
            savedTier,
        ]);
        // Refresh scalar cache columns for all active tiers affected by this graph change.
        this.biddingPriceTiersRepositoryPort.updatePriceTierResolutions(
            persistedGraph.map((tier) => ({
                tierId: tier.tierId,
                resolvedFloorWei: tier.resolvedFloorWei,
                resolvedCeilingWei: tier.resolvedCeilingWei,
                resolvedAt: tier.resolvedAt,
                lastError: null,
            })),
        );
        const views = persistedGraph
            .sort(comparePriceTierRecords)
            .map((tier) => mapResolvedBiddingPriceTierToView(tier));
        const tier = views.find((view) => view.tierId === savedTier.tierId);
        if (!tier) {
            throw new Error(`Saved price tier ${savedTier.tierId} is missing`);
        }

        return {
            chain,
            collection,
            tier,
            tiers: views,
        };
    }
}
