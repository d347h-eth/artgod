import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import { TRADING_BOT_KIND, TRADING_JOB_STATUS } from "@artgod/shared/types";
import type { BiddingJobCeilingPrefillMaximum } from "../../application/use-cases/trading/list-bidding-job-ceiling-prefills.js";

type BiddingJobCeilingPrefillRow = {
    job_id: string;
    collection_id: number;
    ceiling_wei: string;
};

type BiddingJobCeilingPrefillQuery = {
    chainId: number;
    botKind: typeof TRADING_BOT_KIND.Bidding;
    enabledStatus: typeof TRADING_JOB_STATUS.Enabled;
    pausedStatus: typeof TRADING_JOB_STATUS.Paused;
};

// Selects every enabled or paused bidding ceiling for one-pass reduction.
export const BIDDING_JOB_CEILING_PREFILLS_SQL =
    "SELECT j.job_id, j.collection_id, s.ceiling_wei " +
    "FROM trading_jobs j " +
    "JOIN trading_bidding_job_specs s ON s.job_id = j.job_id " +
    "WHERE j.chain_id = @chainId AND j.bot_kind = @botKind " +
    "AND j.status IN (@enabledStatus, @pausedStatus) " +
    "ORDER BY j.status ASC, j.collection_id ASC, j.job_id ASC";

// Reduces one indexed stream of enabled and paused job specs into collection prefills.
export class SqliteBiddingJobCeilingPrefillsRead {
    private readonly selectCeilingPrefills: BetterSqlite3NamedStatement<BiddingJobCeilingPrefillQuery>;

    constructor() {
        this.selectCeilingPrefills = db.prepare<BiddingJobCeilingPrefillQuery>(
            BIDDING_JOB_CEILING_PREFILLS_SQL,
        );
    }

    listCeilingPrefillMaxima(params: {
        chainId: number;
    }): BiddingJobCeilingPrefillMaximum[] {
        const maxima = new Map<number, bigint>();

        // Stream all scopes once and retain only the exact maximum per collection.
        for (const row of this.selectCeilingPrefills.iterate({
            chainId: params.chainId,
            botKind: TRADING_BOT_KIND.Bidding,
            enabledStatus: TRADING_JOB_STATUS.Enabled,
            pausedStatus: TRADING_JOB_STATUS.Paused,
        }) as IterableIterator<BiddingJobCeilingPrefillRow>) {
            const ceiling = parseCanonicalPositiveWei(row);
            const current = maxima.get(row.collection_id);
            if (current === undefined || ceiling > current) {
                maxima.set(row.collection_id, ceiling);
            }
        }

        return [...maxima.entries()]
            .sort(([leftCollectionId], [rightCollectionId]) =>
                leftCollectionId === rightCollectionId
                    ? 0
                    : leftCollectionId < rightCollectionId
                      ? -1
                      : 1,
            )
            .map(([collectionId, maxCeilingWei]) => ({
                collectionId,
                maxCeilingWei: maxCeilingWei.toString(),
            }));
    }
}

function parseCanonicalPositiveWei(row: BiddingJobCeilingPrefillRow): bigint {
    if (!/^[1-9][0-9]*$/.test(row.ceiling_wei)) {
        throw new Error(
            `Bidding job ${row.job_id} has an invalid ceiling_wei value.`,
        );
    }
    const ceiling = BigInt(row.ceiling_wei);
    if (ceiling <= 0n) {
        throw new Error(
            `Bidding job ${row.job_id} has a non-positive ceiling_wei value.`,
        );
    }
    return ceiling;
}
