import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SYNC_WORK_COMPLETION } from "../src/domain/sync-work.js";
import {
    AUTOMATIC_SYNC_METRIC_LABEL,
    AutomaticSyncMetrics,
} from "../src/infra/observability/automatic-sync-metrics.js";
import { createCoordinatorFixture } from "./helpers/coordinated-sync-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { processingTelemetry } from "./helpers/processing-observability.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("committed automatic sync progress", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function fixture(observer: AutomaticSyncMetrics) {
        const services = createCoordinatorFixture({
            observer,
            collectionCount: 2,
            batchSize: 2,
        });
        services.sample(902);
        return services;
    }

    it("counts the shared range once and counts each scoped collection-block pair", async () => {
        const telemetry = await processingTelemetry();
        const h = fixture(new AutomaticSyncMetrics(telemetry.metrics));
        await h.executor.runDue();
        const labels = {
            [AUTOMATIC_SYNC_METRIC_LABEL.Kind]: SYNC_WORK_COMPLETION.Unmanaged,
        };
        expect(
            await telemetry.value("automatic_sync_ranges_total", labels),
        ).toBe(1);
        expect(
            await telemetry.value("automatic_sync_blocks_total", labels),
        ).toBe(2);
        expect(
            await telemetry.value(
                "automatic_sync_collection_blocks_total",
                labels,
            ),
        ).toBe(0);
        await h.executor.runDue();
        await h.executor.runDue();
        expect(
            await telemetry.value("automatic_sync_ranges_total", labels),
        ).toBe(3);
        expect(
            await telemetry.value("automatic_sync_blocks_total", labels),
        ).toBe(6);
        expect(
            await telemetry.value(
                "automatic_sync_collection_blocks_total",
                labels,
            ),
        ).toBe(4);
        expect(
            await telemetry.value(
                "automatic_sync_range_duration_seconds_count",
                labels,
            ),
        ).toBe(3);
        expect(
            await telemetry.value(
                "automatic_sync_last_completed_block",
                labels,
            ),
        ).toBe(902);
        expect(
            await telemetry.value(
                "automatic_sync_last_completed_timestamp_seconds",
                labels,
            ),
        ).toBeGreaterThan(0);
        expect(
            db
                .prepare("SELECT COUNT(*) AS count FROM collection_sync_blocks")
                .get(),
        ).toEqual({ count: 4 });
    });

    it("emits no success progress when the atomic commit fails", async () => {
        const telemetry = await processingTelemetry();
        const h = fixture(new AutomaticSyncMetrics(telemetry.metrics));
        vi.spyOn(h.progress, "advanceChain").mockImplementationOnce(() => {
            throw new Error("progress write failed");
        });
        await h.executor.runDue();
        expect(await telemetry.metrics.metricsText()).not.toContain(
            "automatic_sync_ranges_total",
        );
        expect(
            db
                .prepare("SELECT COUNT(*) AS count FROM collection_sync_blocks")
                .get(),
        ).toEqual({ count: 0 });
    });

    it("does not retry a committed range when its telemetry sink throws", async () => {
        const telemetry = await processingTelemetry();
        const observer = new AutomaticSyncMetrics(telemetry.metrics);
        vi.spyOn(observer, "rangeCompleted").mockImplementation(() => {
            throw new Error("metrics unavailable");
        });
        const h = fixture(observer);
        expect(await h.executor.runDue()).toBe(true);
        expect(
            db
                .prepare("SELECT COUNT(*) AS count FROM collection_sync_blocks")
                .get(),
        ).toEqual({ count: 0 });
        expect(h.progress.chainProgress(1)?.applied.number).toBe(902);
        await h.executor.runDue();
        expect(h.progress.chainProgress(1)?.applied.number).toBe(902);
        expect(
            h.progress.collectionProgress(1, h.collections[0]!.id)?.applied
                .number,
        ).toBe(902);
        expect(
            h.remote.state.logReads.filter(
                (filter) => filter.address === h.collections[0]!.address,
            ).length,
        ).toBeGreaterThan(0);
    });
});
