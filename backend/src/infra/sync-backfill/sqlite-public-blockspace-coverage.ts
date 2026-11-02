import Database from "better-sqlite3";
import { setImmediate } from "node:timers/promises";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import {
    resolveCoverageContext,
    type SyncBackfillReadPort,
} from "../../application/use-cases/sync-backfill/get-sync-backfill-state.js";
import {
    PublicBlockspaceScopeNotFoundError,
    PublicBlockspaceUnavailableError,
    type PublicBlockspaceCoveragePort,
    type PublicBlockspaceScope,
} from "../../application/use-cases/sync-backfill/public-blockspace-coverage.js";
import {
    BLOCKSPACE_COVERAGE_LIMITS,
    BlockspaceCoverageBuilder,
} from "./blockspace-coverage.js";
import { SqliteSyncBackfillRepository } from "./sqlite-sync-backfill-repository.js";

export const PUBLIC_BLOCKSPACE_READ_POLICY = Object.freeze({
    workTurnMs: 4,
    readBudgetMs: 30_000,
});

/** Owns only the coherent SQLite copy; demand and freshness belong to the cache. */
export class SqlitePublicBlockspaceCoverage implements PublicBlockspaceCoveragePort {
    constructor(
        private readonly databasePath: string,
        private readonly timestamps: Pick<
            SyncBackfillReadPort,
            "getBlockTimestamp"
        >,
        private readonly apm: ApmPort = NOOP_APM,
    ) {}

    async load(
        scope: PublicBlockspaceScope,
        signal: AbortSignal,
    ): Promise<SyncBackfillReadPort> {
        const started = performance.now();
        let lastYield = started;
        const check = () => {
            signal.throwIfAborted();
            if (
                performance.now() - started >=
                PUBLIC_BLOCKSPACE_READ_POLICY.readBudgetMs
            ) {
                throw new PublicBlockspaceUnavailableError({
                    cause: new Error("Blockspace read budget exceeded"),
                });
            }
        };
        const cooperate = async () => {
            check();
            if (
                performance.now() - lastYield >=
                PUBLIC_BLOCKSPACE_READ_POLICY.workTurnMs
            ) {
                await setImmediate(undefined, { signal });
                lastYield = performance.now();
                check();
            }
        };

        check();
        // No busy wait on the API event loop, no shared writer transaction,
        // and no global pragma changes. A failed open/read retries on demand.
        const connection = new Database(resolveProjectPath(this.databasePath), {
            readonly: true,
            fileMustExist: true,
            timeout: 0,
        });
        try {
            connection.exec("BEGIN");
            const repository = new SqliteSyncBackfillRepository(
                this.apm,
                connection,
            );
            const collections = repository.listBlockspaceCollections(
                scope.chainId,
            );
            let context;
            try {
                context = resolveCoverageContext(
                    scope.collectionRef,
                    collections,
                );
            } catch (error) {
                if (error instanceof ReadModelNotFoundError)
                    throw new PublicBlockspaceScopeNotFoundError();
                throw error;
            }
            if (context.kind !== "collection")
                throw new PublicBlockspaceScopeNotFoundError();
            const highest = repository.getHighestSyncedBlock(scope.chainId);
            const from = context.deploymentBlock ?? 0;
            const to = Math.max(from, highest ?? from);
            const builder = new BlockspaceCoverageBuilder(from, to);
            // The first yield also lets shutdown cancel a small cold load.
            await setImmediate(undefined, { signal });
            check();
            for (
                let first = from;
                first <= to;
                first += BLOCKSPACE_COVERAGE_LIMITS.countStepBlocks
            ) {
                const last = Math.min(
                    to,
                    first + BLOCKSPACE_COVERAGE_LIMITS.countStepBlocks - 1,
                );
                const count = repository.countSyncedBlocksInRange(
                    scope.chainId,
                    context,
                    { fromBlock: first, toBlock: last },
                );
                await cooperate();
                if (count === last - first + 1) {
                    builder.append(first, last);
                } else if (count > 0) {
                    for (
                        let partial = first;
                        partial <= last;
                        partial +=
                            BLOCKSPACE_COVERAGE_LIMITS.extractionStepBlocks
                    ) {
                        const members =
                            repository.getCollectionSyncedBlocksInRange(
                                scope.chainId,
                                context.collectionId,
                                {
                                    fromBlock: partial,
                                    toBlock: Math.min(
                                        last,
                                        partial +
                                            BLOCKSPACE_COVERAGE_LIMITS.extractionStepBlocks -
                                            1,
                                    ),
                                },
                            );
                        let start: number | undefined;
                        let end: number | undefined;
                        for (const member of members) {
                            if (end !== undefined && member === end + 1)
                                end = member;
                            else {
                                if (start !== undefined)
                                    builder.append(start, end!);
                                start = end = member;
                            }
                        }
                        if (start !== undefined) builder.append(start, end!);
                        await builder.compact(cooperate);
                        await cooperate();
                    }
                }
                await builder.compact(cooperate);
                await cooperate();
            }
            const coverage = await builder.finish(cooperate);
            check();
            return {
                listBlockspaceCollections: (chainId) =>
                    chainId === scope.chainId ? collections : [],
                getHighestSyncedBlock: (chainId) =>
                    chainId === scope.chainId ? highest : null,
                getBlockTimestamp: (chainId, block) =>
                    this.timestamps.getBlockTimestamp(chainId, block),
                countSyncedBlocks: () => coverage.total,
                countSyncedBlocksInRange: (_chain, _context, range) =>
                    coverage.count(range),
                countSyncedBlocksByRange: (_chain, _context, ranges) =>
                    ranges.map((range) => ({
                        ...range,
                        syncedBlockCount: coverage.count(range),
                    })),
            };
        } finally {
            // A returned snapshot owns copied memory only. Closing also rolls
            // back the read view on failures, cancellation, and scope retirement.
            connection.close();
        }
    }
}
