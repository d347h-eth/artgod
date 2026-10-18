import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import {
    flushPendingLogReports,
    LOG_REPORTING_POLICY as POLICY,
} from "@artgod/shared/observability/log-reporting";
import {
    ORDER_DOMAIN_LOG_COMPONENT,
    ORDER_MUTATION_LOG as LOG,
    ORDER_MUTATION_REPORTING_BUCKET as BUCKET,
    OrderMutationProgress,
} from "../src/infra/domain/orders-reporting.js";
import {
    ORDER_UPDATE_REASON,
    type OrderUpsertPayload,
} from "../src/domain/order-jobs.js";
import {
    ORDER_VALIDATION_REASON,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    type OrderSourceStatus,
} from "../src/domain/orders.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import {
    HEAVY_MAKER,
    heavyMakerOrder,
    seedHeavyMaker,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

afterEach(() => {
    flushPendingLogReports();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("aggregates a large mutation burst in fixed counters and finite reason/status buckets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    const report = new OrderMutationProgress(HEAVY_MAKER.chainId);
    for (let i = 0; i < 100_000; i++) report.upserted(i % 2 === 0);
    for (let i = 0; i < 1_000; i++)
        report.sourceUpdated(
            i % 2 === 0,
            ORDER_SOURCE_STATUS.Active,
            `arbitrary-${i}`,
        );
    report.sourceUpdated(
        false,
        ORDER_SOURCE_STATUS.Inactive,
        ORDER_UPDATE_REASON.Validation,
    );
    report.sourceUpdated(
        false,
        "unsupported" as OrderSourceStatus,
        "__proto__",
    );
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(POLICY.intervalMs);
    expect(log).toHaveBeenCalledExactlyOnceWith(LOG.Progress, {
        component: ORDER_DOMAIN_LOG_COMPONENT,
        action: LOG.Action,
        chainId: HEAVY_MAKER.chainId,
        startedAt: 0,
        endedAt: POLICY.intervalMs,
        windowMs: POLICY.intervalMs,
        upserts: { processed: 100_000, changed: 50_000, unchanged: 50_000 },
        sourceUpdates: {
            processed: 1002,
            changed: 500,
            unchanged: 502,
            statuses: Object.fromEntries(
                Object.values(ORDER_SOURCE_STATUS).map((status) => [
                    status,
                    status === ORDER_SOURCE_STATUS.Active
                        ? 1000
                        : status === ORDER_SOURCE_STATUS.Inactive ||
                            status === ORDER_SOURCE_STATUS.Unknown
                          ? 1
                          : 0,
                ]),
            ),
            reasons: {
                [ORDER_UPDATE_REASON.Validation]: 1,
                [ORDER_UPDATE_REASON.Fill]: 0,
                [ORDER_UPDATE_REASON.Cancel]: 0,
                [BUCKET.OtherReason]: 1001,
            },
        },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("arbitrary-");
    vi.advanceTimersByTime(POLICY.intervalMs);
    expect(log).toHaveBeenCalledOnce();
});

it("flushes an order-only partial window once on shutdown and starts with empty counters afterwards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    const report = new OrderMutationProgress(HEAVY_MAKER.chainId);
    report.upserted(true);
    vi.advanceTimersByTime(50);
    flushPendingLogReports();
    flushPendingLogReports();
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenLastCalledWith(
        LOG.Progress,
        expect.objectContaining({
            windowMs: 50,
            upserts: { processed: 1, changed: 1, unchanged: 0 },
        }),
    );
    report.sourceUpdated(
        false,
        ORDER_SOURCE_STATUS.Active,
        ORDER_UPDATE_REASON.Validation,
    );
    flushPendingLogReports();
    expect(log).toHaveBeenLastCalledWith(
        LOG.Progress,
        expect.objectContaining({
            upserts: { processed: 0, changed: 0, unchanged: 0 },
            sourceUpdates: expect.objectContaining({
                processed: 1,
                changed: 0,
                unchanged: 1,
            }),
        }),
    );
});

describe("committed order observations", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(HEAVY_MAKER.now * 1000);
        for (const level of ["debug", "info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        db.exec("DELETE FROM orders; DELETE FROM collections;");
        seedHeavyMaker(0);
    });

    it("observes changed and unchanged results after their writer transaction has committed", async () => {
        const payload = upsert();
        const observer = {
            upserted: vi.fn(() => {
                expect(db.raw.inTransaction).toBe(false);
                expect(stored(payload)?.source_status).toBe(
                    ORDER_SOURCE_STATUS.Active,
                );
            }),
            sourceUpdated: vi.fn(() => {
                expect(db.raw.inTransaction).toBe(false);
                expect(stored(payload)?.source_status).toBe(
                    ORDER_SOURCE_STATUS.Inactive,
                );
            }),
        };
        const domain = createDomain(observer);
        await domain.handleOrderUpsert(payload);
        await domain.handleOrderUpsert(payload);
        expect(observer.upserted.mock.calls).toEqual([[true], [false]]);
        expect(observer.upserted.mock.results.map(({ type }) => type)).toEqual([
            "return",
            "return",
        ]);
        await domain.handleOrderUpdateById(sourceUpdate(payload));
        await domain.handleOrderUpdateById(sourceUpdate(payload));
        expect(observer.sourceUpdated.mock.calls).toEqual([
            [
                true,
                ORDER_SOURCE_STATUS.Inactive,
                ORDER_UPDATE_REASON.Validation,
            ],
            [
                false,
                ORDER_SOURCE_STATUS.Inactive,
                ORDER_UPDATE_REASON.Validation,
            ],
        ]);
        expect(
            observer.sourceUpdated.mock.results.map(({ type }) => type),
        ).toEqual(["return", "return"]);
        expect(logger.debug).not.toHaveBeenCalled();
    });

    it("excludes rolled-back upserts and source updates and counts the successful retry once", async () => {
        const payload = upsert();
        const observer = { upserted: vi.fn(), sourceUpdated: vi.fn() };
        const domain = createDomain(observer);
        db.exec(
            "CREATE TEMP TRIGGER reject_demand BEFORE INSERT ON order_validation_demand BEGIN SELECT RAISE(ABORT, 'fixture demand failure'); END;",
        );
        try {
            await expect(domain.handleOrderUpsert(payload)).rejects.toThrow(
                "fixture demand failure",
            );
            expect(stored(payload)).toBeUndefined();
            expect(observer.upserted).not.toHaveBeenCalled();
        } finally {
            db.exec("DROP TRIGGER reject_demand;");
        }
        await domain.handleOrderUpsert(payload);
        expect(observer.upserted).toHaveBeenCalledExactlyOnceWith(true);
        db.exec(
            "CREATE TEMP TRIGGER reject_source BEFORE UPDATE ON orders BEGIN SELECT RAISE(ABORT, 'fixture source failure'); END;",
        );
        try {
            await expect(
                domain.handleOrderUpdateById(sourceUpdate(payload)),
            ).rejects.toThrow("fixture source failure");
            expect(stored(payload)?.source_status).toBe(
                ORDER_SOURCE_STATUS.Active,
            );
            expect(observer.sourceUpdated).not.toHaveBeenCalled();
        } finally {
            db.exec("DROP TRIGGER reject_source;");
        }
        await domain.handleOrderUpdateById(sourceUpdate(payload));
        expect(observer.sourceUpdated).toHaveBeenCalledExactlyOnceWith(
            true,
            ORDER_SOURCE_STATUS.Inactive,
            ORDER_UPDATE_REASON.Validation,
        );
    });

    it("keeps committed mutations successful when their observer throws", async () => {
        const payload = upsert();
        const fail = () => {
            throw new Error("diagnostic sink failed");
        };
        const domain = createDomain({ upserted: fail, sourceUpdated: fail });
        await expect(domain.handleOrderUpsert(payload)).resolves.toMatchObject({
            changed: true,
        });
        expect(stored(payload)?.source_status).toBe(ORDER_SOURCE_STATUS.Active);
        await expect(
            domain.handleOrderUpdateById(sourceUpdate(payload)),
        ).resolves.toBeUndefined();
        expect(stored(payload)?.source_status).toBe(
            ORDER_SOURCE_STATUS.Inactive,
        );
    });
});

function upsert(): OrderUpsertPayload {
    const order = heavyMakerOrder(10);
    return {
        ...order,
        orderId: order.id,
        rawSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
        observedAt: HEAVY_MAKER.now,
        validateAfterUpsert: true,
    };
}

function sourceUpdate(payload: OrderUpsertPayload) {
    return {
        chainId: payload.chainId,
        orderId: payload.orderId,
        reason: ORDER_UPDATE_REASON.Validation,
        sourceStatus: ORDER_SOURCE_STATUS.Inactive,
        observedAt: HEAVY_MAKER.now,
    };
}

function stored(payload: OrderUpsertPayload) {
    return db
        .prepare<
            [string],
            { source_status: OrderSourceStatus }
        >("SELECT source_status FROM orders WHERE id=?")
        .get(payload.orderId);
}

function createDomain(
    observer: ConstructorParameters<typeof SqliteOrdersDomain>[5],
) {
    return new SqliteOrdersDomain(
        HEAVY_MAKER.weth,
        async () => ({
            status: ORDER_STATUS.Fillable,
            reason: ORDER_VALIDATION_REASON.Erc20FundsAvailable,
        }),
        undefined,
        () => HEAVY_MAKER.now,
        undefined,
        observer,
    );
}
