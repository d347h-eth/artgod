import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import { TRADING_BOT_KIND, TRADING_JOB_STATUS } from "@artgod/shared/types";
import type { ActiveBiddingJobCeilingMaximum } from "../../application/use-cases/trading/list-active-bidding-job-ceilings.js";

type ActiveBiddingJobCeilingRow = {
    job_id: string;
    collection_id: number;
    ceiling_wei: string;
};

type ActiveBiddingJobCeilingQuery = {
    chainId: number;
    botKind: typeof TRADING_BOT_KIND.Bidding;
    status: typeof TRADING_JOB_STATUS.Enabled;
};

// Selects every enabled bidding ceiling in collection order for one-pass reduction.
export const ACTIVE_BIDDING_JOB_CEILINGS_SQL =
    "SELECT j.job_id, j.collection_id, s.ceiling_wei " +
    "FROM trading_jobs j " +
    "JOIN trading_bidding_job_specs s ON s.job_id = j.job_id " +
    "WHERE j.chain_id = @chainId AND j.bot_kind = @botKind AND j.status = @status " +
    "ORDER BY j.collection_id ASC, j.job_id ASC";

// Reduces one indexed stream of enabled job specs into collection maxima.
export class SqliteActiveBiddingJobCeilingsRead {
    private readonly selectActiveCeilings: BetterSqlite3NamedStatement<ActiveBiddingJobCeilingQuery>;

    constructor() {
        this.selectActiveCeilings = db.prepare<ActiveBiddingJobCeilingQuery>(
            ACTIVE_BIDDING_JOB_CEILINGS_SQL,
        );
    }

    listActiveCeilingMaxima(params: {
        chainId: number;
    }): ActiveBiddingJobCeilingMaximum[] {
        const maxima = new Map<number, bigint>();

        // Stream all scopes once and retain only the exact maximum per collection.
        for (const row of this.selectActiveCeilings.iterate({
            chainId: params.chainId,
            botKind: TRADING_BOT_KIND.Bidding,
            status: TRADING_JOB_STATUS.Enabled,
        }) as IterableIterator<ActiveBiddingJobCeilingRow>) {
            const ceiling = parseCanonicalPositiveWei(row);
            const current = maxima.get(row.collection_id);
            if (current === undefined || ceiling > current) {
                maxima.set(row.collection_id, ceiling);
            }
        }

        return [...maxima.entries()].map(([collectionId, maxCeilingWei]) => ({
            collectionId,
            maxCeilingWei: maxCeilingWei.toString(),
        }));
    }
}

function parseCanonicalPositiveWei(row: ActiveBiddingJobCeilingRow): bigint {
    if (!/^[1-9][0-9]*$/.test(row.ceiling_wei)) {
        throw new Error(
            `Enabled bidding job ${row.job_id} has an invalid ceiling_wei value.`,
        );
    }
    const ceiling = BigInt(row.ceiling_wei);
    if (ceiling <= 0n) {
        throw new Error(
            `Enabled bidding job ${row.job_id} has a non-positive ceiling_wei value.`,
        );
    }
    return ceiling;
}
