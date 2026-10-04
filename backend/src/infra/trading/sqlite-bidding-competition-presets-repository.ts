import { randomUUID } from "node:crypto";
import { db } from "@artgod/shared/database";
import type { TradingCompetitionPreset } from "@artgod/shared/types";
import {
    normalizeExtraCompetitionTraits,
    normalizeCompetitionPresetTarget,
} from "@artgod/shared/trading/trait-competition";
import type {
    BiddingCompetitionPresetsRepositoryPort,
    CompetitionPresetScope,
    CompetitionPresetDefinition,
} from "../../application/use-cases/trading/bidding-competition-presets.js";
import { TradingValidationError } from "../../application/use-cases/trading/types.js";

type PresetRow = {
    preset_id: string;
    version_id: string;
    revision: number;
    target_traits_json: string;
    extra_traits_json: string;
    archived_at: string | null;
};
export class SqliteBiddingCompetitionPresetsRepository implements BiddingCompetitionPresetsRepositoryPort {
    listPresets(scope: CompetitionPresetScope): TradingCompetitionPreset[] {
        const rows = db
            .prepare<CompetitionPresetScope>(
                "SELECT p.preset_id, v.version_id, v.revision, v.target_traits_json, v.extra_traits_json, p.archived_at " +
                    "FROM trading_bidding_competition_presets p JOIN trading_bidding_competition_preset_versions v " +
                    "ON v.preset_id = p.preset_id AND v.revision = p.revision " +
                    "WHERE p.chain_id = @chainId AND p.collection_id = @collectionId AND p.archived_at IS NULL ORDER BY p.created_at, p.preset_id",
            )
            .all(scope) as PresetRow[];
        return rows.map((row) => ({
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
        }));
    }

    savePreset(
        input: CompetitionPresetScope & CompetitionPresetDefinition,
    ): TradingCompetitionPreset {
        return db.writeTransaction(() => {
            const presetId = input.presetId ?? randomUUID();
            let revision = 1;
            if (input.presetId) {
                const saved = this.requirePreset(
                    input,
                    presetId,
                    input.expectedRevision,
                );
                revision = saved.revision + 1;
                db.prepare<[number, string]>(
                    "UPDATE trading_bidding_competition_presets SET revision = ?, updated_at = CURRENT_TIMESTAMP WHERE preset_id = ?",
                ).run(revision, presetId);
            } else {
                db.prepare<[string, number, number]>(
                    "INSERT INTO trading_bidding_competition_presets (preset_id, chain_id, collection_id, revision) VALUES (?, ?, ?, 1)",
                ).run(presetId, input.chainId, input.collectionId);
            }
            const versionId = randomUUID();
            db.prepare<[string, string, number, string, string]>(
                "INSERT INTO trading_bidding_competition_preset_versions (version_id, preset_id, revision, target_traits_json, extra_traits_json) VALUES (?, ?, ?, ?, ?)",
            ).run(
                versionId,
                presetId,
                revision,
                JSON.stringify(input.targetTraits),
                JSON.stringify(input.extraCompetitionTraits),
            );
            return {
                presetId,
                versionId,
                revision,
                targetTraits: input.targetTraits,
                extraCompetitionTraits: input.extraCompetitionTraits,
                archivedAt: null,
            };
        })();
    }

    archivePreset(
        input: CompetitionPresetScope & {
            presetId: string;
            expectedRevision: number;
        },
    ): void {
        db.writeTransaction(() => {
            this.requirePreset(input, input.presetId, input.expectedRevision);
            db.prepare<[string]>(
                "UPDATE trading_bidding_competition_presets SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE preset_id = ?",
            ).run(input.presetId);
        })();
    }

    private requirePreset(
        scope: CompetitionPresetScope,
        presetId: string,
        expectedRevision: number | undefined,
    ): { revision: number } {
        const row = db
            .prepare<
                [string, number, number]
            >("SELECT revision FROM trading_bidding_competition_presets WHERE preset_id = ? AND chain_id = ? AND collection_id = ? AND archived_at IS NULL")
            .get(presetId, scope.chainId, scope.collectionId) as
            | { revision: number }
            | undefined;
        if (!row)
            throw new TradingValidationError(
                "Extra targets preset is unavailable. Refresh the presets.",
            );
        if (row.revision !== expectedRevision)
            throw new TradingValidationError(
                "Extra targets preset changed. Refresh it before saving.",
            );
        return row;
    }
}
