import Database from "better-sqlite3";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
    parsePositiveInteger,
    parseRequiredString,
} from "@artgod/shared/utils/env";
import { MAKER_REVALIDATION_STATUS } from "../src/domain/maker-revalidation.js";

export function parseOrderInspectionArgs(args: string[]) {
    const { values } = parseArgs({
        args: args[0] === "--" ? args.slice(1) : args,
        options: {
            db: { type: "string" },
            "chain-id": { type: "string" },
            limit: { type: "string", default: "25" },
            counts: { type: "boolean", default: false },
        },
    });
    const chainId = parsePositiveInteger(
        parseRequiredString(values["chain-id"], "--chain-id"),
        "--chain-id",
    );
    const limit = parsePositiveInteger(values.limit, "--limit");
    if (
        !Number.isSafeInteger(chainId) ||
        !Number.isSafeInteger(limit) ||
        limit > 1000
    )
        throw new Error(
            "Inspection requires a safe chain ID and a limit from 1 to 1000",
        );
    return {
        databasePath: resolve(parseRequiredString(values.db, "--db")),
        chainId,
        limit,
        counts: values.counts,
    };
}

/** No app singleton, migrations, pragmas that write, or broker client are opened. */
export function inspectOrderProcessing(
    config: ReturnType<typeof parseOrderInspectionArgs>,
    now = Date.now(),
) {
    const conn = new Database(config.databasePath, {
        readonly: true,
        fileMustExist: true,
        timeout: 1000,
    });
    try {
        conn.pragma("query_only=ON");
        return conn.transaction(() => {
            const demands = conn
                .prepare(
                    "SELECT order_id AS orderId,revision,generation,required_at AS requiredAt,minimum_block AS minimumBlock,lease_until AS leaseUntil,next_attempt_at AS nextAttemptAt,failures,last_error AS lastError FROM order_validation_demand WHERE pending=1 AND chain_id=? ORDER BY next_attempt_at,lease_until,updated_at,order_id LIMIT ?",
                )
                .all(config.chainId, config.limit) as Array<{
                requiredAt: number;
            }>;
            const makers = conn
                .prepare(
                    "SELECT run_id AS runId,source_job_id AS sourceJobId,status,step,resolved_orders AS resolvedOrders,deferred_orders AS deferredOrders,isolate_order_id AS isolateOrderId,after_id AS afterId,upper_order_id AS upperOrderId,generation,pass_generation AS passGeneration,requested_at AS requestedAt,lease_until AS leaseUntil,failures,last_error AS lastError,wakeup_outbox_id AS wakeupOutboxId FROM maker_order_revalidation_runs WHERE status=? AND chain_id=? ORDER BY recovery_checked_at,updated_at,run_id LIMIT ?",
                )
                .all(
                    MAKER_REVALIDATION_STATUS.Pending,
                    config.chainId,
                    config.limit,
                ) as Array<{ wakeupOutboxId: number | null }>;
            return {
                observedAt: now,
                chainId: config.chainId,
                sampleLimit: config.limit,
                // This is a bounded scheduler-order sample, not the global oldest row.
                demandSample: demands.map((demand) => ({
                    ...demand,
                    ageMs: Math.max(0, now - demand.requiredAt),
                })),
                makerSample: makers.map((maker) => ({
                    ...maker,
                    wakeup:
                        maker.wakeupOutboxId == null
                            ? null
                            : (conn
                                  .prepare(
                                      "SELECT queue_name AS queue,status,attempts,last_error AS lastError,publication_stream_id AS streamId,publication_sequence AS sequence FROM queue_outbox WHERE outbox_id=?",
                                  )
                                  .get(maker.wakeupOutboxId) ?? null),
                })),
                counts: config.counts
                    ? {
                          demands: conn
                              .prepare(
                                  "SELECT pending,COUNT(*) AS count FROM order_validation_demand WHERE chain_id=? GROUP BY pending",
                              )
                              .all(config.chainId),
                          // Full aggregate is deliberately opt-in; the default sample
                          // cannot establish global age or how much work is immediately due.
                          pendingDemand: (() => {
                              const row = conn
                                  .prepare(
                                      "SELECT COUNT(*) AS count,COALESCE(SUM(next_attempt_at<=? AND lease_until<=?),0) AS due,COALESCE(SUM(lease_until>?),0) AS leased,COALESCE(SUM(next_attempt_at>? AND lease_until<=?),0) AS backoff,COALESCE(SUM(failures>0),0) AS withFailures,MIN(required_at) AS oldestRequiredAt FROM order_validation_demand WHERE pending=1 AND chain_id=?",
                                  )
                                  .get(
                                      now,
                                      now,
                                      now,
                                      now,
                                      now,
                                      config.chainId,
                                  ) as {
                                  count: number;
                                  due: number;
                                  leased: number;
                                  backoff: number;
                                  withFailures: number;
                                  oldestRequiredAt: number | null;
                              };
                              return {
                                  ...row,
                                  oldestRequiredAgeMs:
                                      row.oldestRequiredAt === null
                                          ? null
                                          : Math.max(
                                                0,
                                                now - row.oldestRequiredAt,
                                            ),
                              };
                          })(),
                          makers: conn
                              .prepare(
                                  "SELECT status,COUNT(*) AS count FROM maker_order_revalidation_runs WHERE chain_id=? GROUP BY status",
                              )
                              .all(config.chainId),
                      }
                    : null,
            };
        })();
    } finally {
        conn.close();
    }
}
