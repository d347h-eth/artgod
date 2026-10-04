import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type { BiddingCompetitionPresetReapplyUseCase } from "../../../application/use-cases/trading/bidding-competition-preset-reapply.js";
import {
    parsePositiveRevision,
    parseRequiredString,
} from "./trading-job-http.js";

export type CompetitionPresetReapplyRoute = {
    Params: { chain_ref: string; collection_ref: string; preset_id: string };
    Body: Record<string, unknown>;
};
export type BiddingCompetitionPresetReapplyPort = Pick<
    BiddingCompetitionPresetReapplyUseCase,
    "previewCompetitionPresetReapply" | "applyCompetitionPresetReapply"
>;

export class BiddingCompetitionPresetReapplyHttpAdapter {
    constructor(readonly reapply: BiddingCompetitionPresetReapplyPort) {}

    readonly preview = async (
        request: FastifyRequest<CompetitionPresetReapplyRoute>,
    ) => this.reapply.previewCompetitionPresetReapply(this.scope(request));

    readonly apply = async (
        request: FastifyRequest<CompetitionPresetReapplyRoute>,
    ) => {
        const body = request.body ?? {};
        if (!Array.isArray(body.jobs))
            throw new ReadModelBadRequestError("jobs must be an array");
        const jobs = body.jobs.map((value: unknown) => {
            if (!value || typeof value !== "object" || Array.isArray(value))
                throw new ReadModelBadRequestError(
                    "Each selected job needs its reviewed revision and preset version.",
                );
            const selection = value as Record<string, unknown>;
            return {
                jobId: parseRequiredString(selection.jobId, "jobId"),
                expectedRevision: parsePositiveRevision(
                    selection.expectedRevision,
                ),
                versionId: parseRequiredString(
                    selection.versionId,
                    "versionId",
                ),
            };
        });
        return this.reapply.applyCompetitionPresetReapply({
            ...this.scope(request),
            expectedRevision: parsePositiveRevision(body.expectedRevision),
            jobs,
        });
    };

    private scope(request: FastifyRequest<CompetitionPresetReapplyRoute>) {
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            presetId: parseRequiredString(request.params.preset_id, "presetId"),
        };
    }
}
