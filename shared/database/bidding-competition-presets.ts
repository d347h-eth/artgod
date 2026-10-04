import type {
    TradingCompetitionPreset,
    TradingCompetitionPresetVersion,
    TradingTraitCriterion,
} from "../types/trading.js";
import { db } from "./db.js";
import {
    competitionPresetMatchesTarget,
    normalizeExtraCompetitionTraits,
    normalizeCompetitionPresetTarget,
} from "../trading/trait-competition.js";

export type CurrentBiddingCompetitionPresetRow = {
    preset_id: string;
    version_id: string;
    revision: number;
    target_traits_json: string;
    extra_traits_json: string;
    archived_at: string | null;
};

export const CURRENT_BIDDING_COMPETITION_PRESET_SELECT =
    "SELECT p.preset_id, v.version_id, v.revision, v.target_traits_json, v.extra_traits_json, p.archived_at " +
    "FROM trading_bidding_competition_presets p JOIN trading_bidding_competition_preset_versions v " +
    "ON v.preset_id = p.preset_id AND v.revision = p.revision ";

export function mapCurrentBiddingCompetitionPresetRow(
    row: CurrentBiddingCompetitionPresetRow,
): TradingCompetitionPreset {
    return {
        presetId: row.preset_id,
        versionId: row.version_id,
        revision: row.revision,
        targetTraits: normalizeCompetitionPresetTarget(
            JSON.parse(row.target_traits_json),
        ),
        extraCompetitionTraits: normalizeExtraCompetitionTraits(
            JSON.parse(row.extra_traits_json),
        ),
        archivedAt: row.archived_at,
    };
}

// The inventory and atomic bulk writer read the same current-version projection.
export function readCurrentBiddingCompetitionPreset(
    scope: { chainId: number; collectionId: number },
    presetId: string,
): TradingCompetitionPreset | null {
    const row = db
        .prepare<
            [string, number, number]
        >(CURRENT_BIDDING_COMPETITION_PRESET_SELECT + "WHERE p.preset_id = ? AND p.chain_id = ? AND p.collection_id = ?")
        .get(presetId, scope.chainId, scope.collectionId) as
        | CurrentBiddingCompetitionPresetRow
        | undefined;
    return row ? mapCurrentBiddingCompetitionPresetRow(row) : null;
}

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
