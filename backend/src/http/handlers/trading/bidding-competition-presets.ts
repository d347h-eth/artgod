import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    normalizeExtraCompetitionTraits,
    normalizeTraitBiddingTarget,
    TraitCompetitionValidationError,
} from "@artgod/shared/trading/trait-competition";
import type { BiddingCompetitionPresetsUseCase } from "../../../application/use-cases/trading/bidding-competition-presets.js";
import {
    parseOptionalString,
    parseRequiredString,
} from "./trading-job-http.js";

export type CompetitionPresetsRoute = {
    Params: { chain_ref: string; collection_ref: string };
    Body: Record<string, unknown>;
};
export type ArchiveCompetitionPresetRoute = CompetitionPresetsRoute & {
    Params: CompetitionPresetsRoute["Params"] & { preset_id: string };
};
export type BiddingCompetitionPresetsPort = Pick<
    BiddingCompetitionPresetsUseCase,
    | "listCompetitionPresets"
    | "upsertCompetitionPreset"
    | "archiveCompetitionPreset"
>;

export class BiddingCompetitionPresetsHttpAdapter {
    constructor(readonly presets: BiddingCompetitionPresetsPort) {}
    readonly list = async (request: FastifyRequest<CompetitionPresetsRoute>) =>
        this.presets.listCompetitionPresets(this.scope(request));
    readonly upsert = async (
        request: FastifyRequest<CompetitionPresetsRoute>,
    ) => {
        const body = request.body ?? {};
        try {
            return this.presets.upsertCompetitionPreset({
                ...this.scope(request),
                presetId: parseOptionalString(body.presetId, "presetId"),
                expectedRevision:
                    body.expectedRevision === undefined
                        ? undefined
                        : parseRevision(body.expectedRevision),
                targetTraits: normalizeTraitBiddingTarget(body.targetTraits),
                extraCompetitionTraits: normalizeExtraCompetitionTraits(
                    body.extraCompetitionTraits,
                ),
            });
        } catch (error) {
            if (error instanceof TraitCompetitionValidationError)
                throw new ReadModelBadRequestError(error.message);
            throw error;
        }
    };
    readonly archive = async (
        request: FastifyRequest<ArchiveCompetitionPresetRoute>,
    ) =>
        this.presets.archiveCompetitionPreset({
            ...this.scope(request),
            presetId: parseRequiredString(request.params.preset_id, "presetId"),
            expectedRevision: parseRevision(request.body?.expectedRevision),
        });

    private scope(request: FastifyRequest<CompetitionPresetsRoute>) {
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
        };
    }
}

function parseRevision(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
        throw new ReadModelBadRequestError(
            "expectedRevision must be a positive integer",
        );
    return value;
}
