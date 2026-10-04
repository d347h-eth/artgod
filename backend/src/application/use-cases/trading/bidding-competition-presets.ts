import type {
    ChainRecord,
    CollectionListItem,
    TradingCompetitionPreset,
    TradingTraitCriterion,
    TradingTraitCompetitionSelector,
} from "@artgod/shared/types";
import {
    normalizeExtraCompetitionTraits,
    normalizeCompetitionPresetTarget,
    TraitCompetitionValidationError,
} from "@artgod/shared/trading/trait-competition";
import {
    assertMarketplaceBiddingSupportedTargetTraits,
    type TraitBiddingTargetSupportReadPort,
} from "./trait-bidding-target.js";
import { TradingValidationError } from "./types.js";

export type CompetitionPresetScope = { chainId: number; collectionId: number };
export type CompetitionPresetDefinition = {
    presetId?: string;
    // Required on edit to prevent stale editors from overwriting a newer version.
    expectedRevision?: number;
    targetTraits: TradingTraitCompetitionSelector[];
    extraCompetitionTraits: TradingTraitCompetitionSelector[];
};
export interface BiddingCompetitionPresetsRepositoryPort {
    listPresets(scope: CompetitionPresetScope): TradingCompetitionPreset[];
    savePreset(
        input: CompetitionPresetScope & CompetitionPresetDefinition,
    ): TradingCompetitionPreset;
    archivePreset(
        input: CompetitionPresetScope & {
            presetId: string;
            expectedRevision: number;
        },
    ): void;
}
export type CompetitionPresetsInput = {
    chainRef: string;
    collectionRef: string;
};
export type CompetitionPresetsOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    presets: TradingCompetitionPreset[];
};
export type UpsertCompetitionPresetInput = CompetitionPresetsInput &
    CompetitionPresetDefinition;
export type ArchiveCompetitionPresetInput = CompetitionPresetsInput & {
    presetId: string;
    expectedRevision: number;
};

export class BiddingCompetitionPresetsUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chains: {
            resolveChainRef(
                ref: string | undefined,
                defaultChainId: number,
            ): ChainRecord;
        },
        readonly collections: {
            resolveCollectionRef(
                chainId: number,
                ref: string,
            ): CollectionListItem;
        },
        readonly targets: TraitBiddingTargetSupportReadPort,
        readonly catalog: {
            listCollectionTraitCatalog(
                input: CompetitionPresetScope & { keys: string[] },
            ): { key: string; values: { value: string }[] }[];
        },
        readonly presets: BiddingCompetitionPresetsRepositoryPort,
    ) {}

    listCompetitionPresets(
        input: CompetitionPresetsInput,
    ): CompetitionPresetsOutput {
        const { chain, collection, scope } = this.resolveScope(input);
        return { chain, collection, presets: this.presets.listPresets(scope) };
    }

    upsertCompetitionPreset(
        input: UpsertCompetitionPresetInput,
    ): CompetitionPresetsOutput {
        const { chain, collection, scope } = this.resolveScope(input);
        let targetTraits: TradingTraitCompetitionSelector[];
        let extraCompetitionTraits: TradingTraitCompetitionSelector[];
        try {
            targetTraits = normalizeCompetitionPresetTarget(input.targetTraits);
            extraCompetitionTraits = normalizeExtraCompetitionTraits(
                input.extraCompetitionTraits,
            );
        } catch (error) {
            if (error instanceof TraitCompetitionValidationError)
                throw new TradingValidationError(error.message);
            throw error;
        }
        if (!extraCompetitionTraits.length)
            throw new TradingValidationError(
                "Choose at least one extra target.",
            );
        assertMarketplaceBiddingSupportedTargetTraits({
            ...scope,
            targetTraits: targetTraits.filter(
                (trait): trait is TradingTraitCriterion =>
                    trait.value !== undefined,
            ),
            traitBiddingTargetSupportReadPort: this.targets,
        });
        // Whole source keys and extras use the unfiltered catalog. Do not expand
        // source wildcards: job creation validates the actual concrete target.
        const catalogSelectors = [
            ...targetTraits.filter((trait) => trait.value === undefined),
            ...extraCompetitionTraits,
        ];
        const facets = this.catalog.listCollectionTraitCatalog({
            ...scope,
            keys: [...new Set(catalogSelectors.map((t) => t.type))],
        });
        if (
            catalogSelectors.some(
                (t) =>
                    !facets.some(
                        (f) =>
                            f.key === t.type &&
                            (t.value === undefined ||
                                f.values.some((v) => v.value === t.value)),
                    ),
            )
        ) {
            throw new TradingValidationError(
                "Choose the target and extra targets from this collection's traits.",
            );
        }
        this.presets.savePreset({
            ...scope,
            presetId: input.presetId,
            expectedRevision: input.expectedRevision,
            targetTraits,
            extraCompetitionTraits,
        });
        return { chain, collection, presets: this.presets.listPresets(scope) };
    }

    archiveCompetitionPreset(
        input: ArchiveCompetitionPresetInput,
    ): CompetitionPresetsOutput {
        const { chain, collection, scope } = this.resolveScope(input);
        this.presets.archivePreset({
            ...scope,
            presetId: input.presetId,
            expectedRevision: input.expectedRevision,
        });
        return { chain, collection, presets: this.presets.listPresets(scope) };
    }

    private resolveScope(input: CompetitionPresetsInput) {
        const chain = this.chains.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collections.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        return {
            chain,
            collection,
            scope: {
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            },
        };
    }
}
