import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SYNC_WORK_COMPLETION } from "../src/domain/sync-work.js";
import {
    AUTOMATIC_SYNC_METRIC_LABEL,
    AutomaticSyncMetrics,
} from "../src/infra/observability/automatic-sync-metrics.js";
import {
    RecoveryRpc,
    reorgRecoveryServices,
} from "./helpers/reorg-recovery-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import { processingTelemetry } from "./helpers/processing-observability.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("committed automatic sync progress", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function fixture(observer: AutomaticSyncMetrics) {
        const rpc = new RecoveryRpc(200);
        const services = reorgRecoveryServices(rpc, { observer });
        for (let index = 1; index <= 2; index++) {
            const id = insertCollection({
                chainId: 1,
                slug: `metrics-${index}`,
                address: `0x${String(index).padStart(40, "0")}`,
                anchorBlock: 105,
            });
            services.gaps.saveProgress({
                chainId: 1,
                collectionId: id,
                expected: null,
                progress: {
                    anchorBlock: 105,
                    cursorBlock: null,
                    lastHeadCheckAt: Date.now(),
                    pending: {
                        repairId: `metrics:${id}`,
                        fromBlock: 105,
                        toBlock: 106,
                        retryAt: 0,
                    },
                },
            });
        }
        return { ...services, rpc };
    }

    it("counts one shared range once and counts each processed collection-block pair", async () => {
        const telemetry = await processingTelemetry();
        const h = fixture(new AutomaticSyncMetrics(telemetry.metrics));
        await h.executor.runDue();
        const labels = {
            [AUTOMATIC_SYNC_METRIC_LABEL.Kind]: SYNC_WORK_COMPLETION.GapRepair,
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
        ).toBe(4);
        expect(
            await telemetry.value(
                "automatic_sync_range_duration_seconds_count",
                labels,
            ),
        ).toBe(1);
        expect(
            await telemetry.value(
                "automatic_sync_last_completed_block",
                labels,
            ),
        ).toBe(106);
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
        vi.spyOn(h.gaps, "recordRepairProgress").mockReturnValue(false);
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
        ).toEqual({ count: 4 });
        expect(
            h.gaps.listDueRepairsAtNewestPendingHeight({
                chainId: 1,
                now: Date.now(),
                upperBound: 106,
                limit: 16,
            }),
        ).toEqual([]);
    });
});
