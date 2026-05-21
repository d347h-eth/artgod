import { describe, expect, it } from "vitest";
import {
    BackfillExecutionGate,
    BACKFILL_EXECUTION_MODE,
    resolveBackfillExecutionMode,
} from "../src/application/backfill-execution.js";
import { CollectionRecord } from "../src/domain/collections.js";

describe("backfill execution policy", () => {
    it("allows parallel execution for ranges fully before the collection anchor", () => {
        const mode = resolveBackfillExecutionMode(
            [collectionRecord({ anchorBlock: 100 })],
            { fromBlock: 1, toBlock: 100 },
        );

        expect(mode).toBe(BACKFILL_EXECUTION_MODE.ParallelFactsOnly);
    });

    it("serializes ranges that intersect current-state projection", () => {
        const mode = resolveBackfillExecutionMode(
            [collectionRecord({ anchorBlock: 100 })],
            { fromBlock: 100, toBlock: 101 },
        );

        expect(mode).toBe(BACKFILL_EXECUTION_MODE.SerializedCurrentState);
    });

    it("serializes ranges when any affected collection is not facts-only", () => {
        const mode = resolveBackfillExecutionMode(
            [
                collectionRecord({ id: 1, anchorBlock: 200 }),
                collectionRecord({ id: 2, anchorBlock: 100 }),
            ],
            { fromBlock: 50, toBlock: 150 },
        );

        expect(mode).toBe(BACKFILL_EXECUTION_MODE.SerializedCurrentState);
    });

    it("requires a settled anchor before treating a range as parallel-safe", () => {
        const mode = resolveBackfillExecutionMode(
            [collectionRecord({ anchorBlock: null })],
            { fromBlock: 1, toBlock: 10 },
        );

        expect(mode).toBe(BACKFILL_EXECUTION_MODE.SerializedCurrentState);
    });

    it("serializes current-state-capable tasks", async () => {
        const gate = new BackfillExecutionGate();
        const events: string[] = [];
        let releaseFirst: (() => void) | undefined;

        const first = gate.run(
            BACKFILL_EXECUTION_MODE.SerializedCurrentState,
            async () => {
                events.push("first:start");
                await new Promise<void>((resolve) => {
                    releaseFirst = resolve;
                });
                events.push("first:end");
            },
        );
        const second = gate.run(
            BACKFILL_EXECUTION_MODE.SerializedCurrentState,
            async () => {
                events.push("second:start");
                events.push("second:end");
            },
        );

        await Promise.resolve();
        expect(events).toEqual(["first:start"]);

        releaseFirst?.();
        await Promise.all([first, second]);

        expect(events).toEqual([
            "first:start",
            "first:end",
            "second:start",
            "second:end",
        ]);
    });

    it("does not serialize facts-only tasks", async () => {
        const gate = new BackfillExecutionGate();
        const events: string[] = [];
        let releaseCurrentState: (() => void) | undefined;

        const currentState = gate.run(
            BACKFILL_EXECUTION_MODE.SerializedCurrentState,
            async () => {
                events.push("current:start");
                await new Promise<void>((resolve) => {
                    releaseCurrentState = resolve;
                });
                events.push("current:end");
            },
        );
        await Promise.resolve();

        const factsOnly = gate.run(
            BACKFILL_EXECUTION_MODE.ParallelFactsOnly,
            async () => {
                events.push("facts-only");
            },
        );
        await factsOnly;

        expect(events).toEqual(["current:start", "facts-only"]);

        releaseCurrentState?.();
        await currentState;
    });
});

function collectionRecord(input: {
    id?: number;
    anchorBlock: number | null;
}): CollectionRecord {
    const id = input.id ?? 1;
    return CollectionRecord.fromPersistence({
        chainId: 1,
        id,
        slug: `collection-${id}`,
        address: `0x${String(id).padStart(40, "0")}`,
        standard: "erc721",
        status: "live",
        tokenScopeKind: "contract_all_tokens",
        scopeStartTokenId: null,
        scopeTotalSupply: null,
        deploymentBlock: null,
        bootstrapAnchorBlock: input.anchorBlock,
        bootstrapStartedAt: null,
        bootstrapFinishedAt: null,
        bootstrapLastSyncedBlock: null,
        openseaSlug: null,
        openseaStatus: null,
        openseaReadyAt: null,
        openseaSnapshotStartedAt: null,
        openseaSnapshotCompletedAt: null,
        openseaReconcileStartedAt: null,
        openseaReconcileCompletedAt: null,
        openseaLastStreamEventAt: null,
        openseaLastStreamHealthyAt: null,
        openseaLastError: null,
    });
}
