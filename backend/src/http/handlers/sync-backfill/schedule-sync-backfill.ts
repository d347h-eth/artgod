import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    ScheduleSyncBackfillInput,
    ScheduleSyncBackfillOutput,
    ScheduleSyncBackfillUseCase,
} from "../../../application/use-cases/sync-backfill/schedule-sync-backfill.js";

export type ScheduleSyncBackfillRoute = {
    Params: {
        chain_ref: string;
    };
    Body: {
        collectionRef?: unknown;
        fromBlock?: unknown;
        toBlock?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ScheduleSyncBackfillHttpAdapter {
    constructor(
        private readonly scheduleSyncBackfillPort:
            | {
                  scheduleBackfill(
                      input: ScheduleSyncBackfillInput,
                  ): MaybePromise<ScheduleSyncBackfillOutput>;
              }
            | ScheduleSyncBackfillUseCase,
    ) {}

    readonly handle = async (
        request: FastifyRequest<ScheduleSyncBackfillRoute>,
    ) => {
        const body = request.body ?? {};
        return this.scheduleSyncBackfillPort.scheduleBackfill({
            chainRef: request.params.chain_ref,
            collectionRef: parseOptionalString(body.collectionRef),
            fromBlock: mustInteger(body.fromBlock, "fromBlock"),
            toBlock: mustInteger(body.toBlock, "toBlock"),
        });
    };
}

function parseOptionalString(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
        throw new ReadModelBadRequestError("collectionRef must be a string");
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function mustInteger(value: unknown, field: string): number {
    if (!Number.isInteger(value)) {
        throw new ReadModelBadRequestError(`${field} must be an integer`);
    }
    return Number(value);
}
