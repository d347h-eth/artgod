import type {
    TradingCompetitionPresetVersion,
    TradingTraitCriterion,
} from "../types/trading.js";
import {
    competitionPresetMatchesTarget,
    normalizeExtraCompetitionTraits,
    normalizeCompetitionPresetTarget,
} from "../trading/trait-competition.js";

// Shared projection resolves versions in the job query, avoiding per-job reads.
export const BIDDING_COMPETITION_PRESET_SQL = {
    fields: "s.competition_preset_version_id, v.preset_id AS competition_preset_id, v.revision AS competition_preset_revision, v.target_traits_json AS preset_target_traits_json, v.extra_traits_json AS preset_extra_traits_json, p.chain_id AS preset_chain_id, p.collection_id AS preset_collection_id, ",
    joins: "LEFT JOIN trading_bidding_competition_preset_versions v ON v.version_id = s.competition_preset_version_id LEFT JOIN trading_bidding_competition_presets p ON p.preset_id = v.preset_id ",
} as const;

export type BiddingCompetitionPresetRow = {
    competition_preset_version_id: string | null;
    competition_preset_id: string | null;
    competition_preset_revision: number | null;
    preset_target_traits_json: string | null;
    preset_extra_traits_json: string | null;
    preset_chain_id: number | null;
    preset_collection_id: number | null;
};

export function mapBiddingCompetitionPresetRow(
    row: BiddingCompetitionPresetRow,
    scope: { chainId: number; collectionId: number },
    targetTraits: TradingTraitCriterion[],
): TradingCompetitionPresetVersion | null {
    if (row.competition_preset_version_id === null) return null;
    if (
        !row.competition_preset_id ||
        !row.competition_preset_revision ||
        !row.preset_target_traits_json ||
        !row.preset_extra_traits_json ||
        row.preset_chain_id !== scope.chainId ||
        row.preset_collection_id !== scope.collectionId
    ) {
        throw new Error("Invalid persisted extra targets reference");
    }
    const preset = {
        versionId: row.competition_preset_version_id,
        presetId: row.competition_preset_id,
        revision: row.competition_preset_revision,
        targetTraits: normalizeCompetitionPresetTarget(
            JSON.parse(row.preset_target_traits_json),
        ),
        extraCompetitionTraits: normalizeExtraCompetitionTraits(
            JSON.parse(row.preset_extra_traits_json),
        ),
    };
    if (!competitionPresetMatchesTarget(preset, targetTraits))
        throw new Error(
            "Persisted extra targets source does not match the job",
        );
    return preset;
}
