import { describe, expect, it, vi } from "vitest";
import {
    COLLECTION_STATUS,
    OPENSEA_STREAM_INGESTION_STATUS,
} from "@artgod/shared/types";
import {
    buildCanonicalOrderEffects,
    canonicalOrderEffectId,
    type CanonicalOrderEffect,
} from "../src/domain/canonical-order-effects.js";
import {
    CollectionRecord,
    COLLECTION_STANDARD,
} from "../src/domain/collections.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import {
    COLLECTION_SCOPED_MAKER_TRIGGER_REASON,
    GLOBAL_MAKER_TRIGGER_REASON,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
} from "../src/domain/maker-triggers.js";
import {
    MAKER_TRIGGER_SCOPE,
    ORDER_UPDATE_REASON,
} from "../src/domain/order-jobs.js";
import { BACKFILL_ORDER_MAINTENANCE_POLICY } from "../src/domain/sync-jobs.js";
import { RetainCanonicalOrderEffects } from "../src/application/orders/retain-canonical-order-effects.js";
import type { MakerRevalidationStore } from "../src/ports/maker-revalidation.js";
import { emptyOnChainData } from "./helpers/ownership-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";

const CHAIN = 1;
const COLLECTION = 7;
const CONTRACT = "0x0000000000000000000000000000000000000007";
const MAKER = "0x00000000000000000000000000000000000000aa";
const CURRENT = BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState;

function collection(anchor = 900) {
    return CollectionRecord.fromPersistence({
        chainId: CHAIN,
        id: COLLECTION,
        slug: "fixture",
        address: CONTRACT,
        standard: COLLECTION_STANDARD.Erc721,
        status: COLLECTION_STATUS.Live,
        tokenScopeKind: "contract_all_tokens",
        scopeStartTokenId: null,
        scopeTotalSupply: null,
        deploymentBlock: 1,
        bootstrapAnchorBlock: anchor,
        bootstrapStartedAt: null,
        bootstrapFinishedAt: null,
        bootstrapLastSyncedBlock: null,
        openseaSlug: null,
        openseaStatus: null,
        openseaStreamIngestionStatus: OPENSEA_STREAM_INGESTION_STATUS.Enabled,
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

function attribution(logIndex = 1, blockNumber = 901) {
    return {
        blockNumber,
        blockHash: syncBlockFixture(blockNumber).hash,
        txHash: `0x${"ab".repeat(32)}`,
        logIndex,
    };
}

function fixture() {
    const data = emptyOnChainData();
    data.collectionScoped.makerTriggers.push(
        {
            ...attribution(1),
            collectionId: COLLECTION,
            contract: CONTRACT,
            tokenId: "1",
            maker: MAKER,
            reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
        },
        {
            ...attribution(2),
            collectionId: COLLECTION,
            contract: CONTRACT,
            maker: MAKER,
            reason: COLLECTION_SCOPED_MAKER_TRIGGER_REASON.NftApprovalForAll,
        },
    );
    data.global.makerTriggers.push({
        ...attribution(3),
        maker: MAKER,
        reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
    });
    data.collectionScoped.fillEvents.push({
        ...attribution(4),
        collectionId: COLLECTION,
        contract: CONTRACT,
        tokenId: "1",
        orderId: "filled-order",
        execution: { protocolAddress: CONTRACT, items: [] },
        executionItemIndex: 0,
    });
    data.global.cancelEvents.push({
        ...attribution(5),
        orderId: "cancelled-order",
    });
    data.collectionScoped.orderInfos.push({
        ...attribution(6),
        collectionId: COLLECTION,
        contract: CONTRACT,
        tokenId: "1",
        orderId: "created-order",
    });
    return {
        chainId: CHAIN,
        collections: [collection()],
        data,
        orderMaintenancePolicy: CURRENT,
        applyingShared: true,
    };
}

describe("canonical order effects before applied progress", () => {
    it("keeps exact chain attribution and existing token, collection and maker scopes", () => {
        const effects = buildCanonicalOrderEffects(fixture());
        expect(effects).toHaveLength(6);
        expect(effects.slice(0, 3).map((effect) => effect.payload)).toEqual([
            expect.objectContaining({
                scope: MAKER_TRIGGER_SCOPE.Token,
                collectionId: COLLECTION,
                tokenId: "1",
            }),
            expect.objectContaining({
                scope: MAKER_TRIGGER_SCOPE.Collection,
                collectionId: COLLECTION,
            }),
            expect.objectContaining({
                scope: MAKER_TRIGGER_SCOPE.Global,
                reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
            }),
        ]);
        expect(effects.slice(3).map((effect) => effect.payload.reason)).toEqual(
            [
                ORDER_UPDATE_REASON.Fill,
                ORDER_UPDATE_REASON.Cancel,
                ORDER_UPDATE_REASON.Validation,
            ],
        );
        effects.forEach((effect, index) =>
            expect(effect.payload).toMatchObject({
                chainId: CHAIN,
                ...attribution(index + 1),
            }),
        );
    });

    it("creates no current effects for historical policy, unselected scopes or pre-anchor facts", () => {
        const input = fixture();
        expect(
            buildCanonicalOrderEffects({
                ...input,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
            }),
        ).toEqual([]);
        expect(
            buildCanonicalOrderEffects({
                ...input,
                collections: [],
                applyingShared: false,
            }),
        ).toEqual([]);
        expect(
            buildCanonicalOrderEffects({
                ...input,
                collections: [collection(901)],
                applyingShared: false,
            }),
        ).toEqual([]);
        input.data.collectionScoped.makerTriggers[0]!.collectionId = 999;
        expect(buildCanonicalOrderEffects(input)).toHaveLength(5);
    });

    it("gives replacement-chain events distinct replay identity at the same height and log", () => {
        const original = buildCanonicalOrderEffects(fixture());
        const replacement = original.map((effect) => ({
            ...effect,
            payload: {
                ...effect.payload,
                blockHash: syncBlockFixture(1901).hash,
            },
        })) as CanonicalOrderEffect[];
        expect(
            new Set([...original, ...replacement].map(canonicalOrderEffectId))
                .size,
        ).toBe(original.length * 2);
    });

    it("retains global effects during shared advancement without any ready collection", () => {
        const effects = buildCanonicalOrderEffects({
            ...fixture(),
            collections: [],
        });
        expect(effects.map((effect) => effect.payload.reason)).toEqual([
            GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
            ORDER_UPDATE_REASON.Cancel,
        ]);
    });

    it("does not repeat global effects during collection-only catch-up", () => {
        const effects = buildCanonicalOrderEffects({
            ...fixture(),
            applyingShared: false,
        });
        expect(effects.map((effect) => effect.payload.reason)).toEqual([
            TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
            COLLECTION_SCOPED_MAKER_TRIGGER_REASON.NftApprovalForAll,
            ORDER_UPDATE_REASON.Fill,
            ORDER_UPDATE_REASON.Validation,
        ]);
    });

    it("retains one bounded maker obligation per effect and applies by-ID facts synchronously without RPC", () => {
        const applyCanonicalOrderUpdate = vi.fn();
        // The orchestrator consumes admission's durability, never an executor or
        // its candidate-page methods. Actual scan coverage remains adapter-owned.
        const admit = vi.fn<MakerRevalidationStore["admit"]>();
        const operation = new RetainCanonicalOrderEffects({
            orders: { applyCanonicalOrderUpdate },
            makers: { admit, scheduleWakeup: vi.fn() },
        });
        const effects = buildCanonicalOrderEffects(fixture());
        const checkpoint = { chainId: CHAIN, revision: 3 };
        expect(
            operation.retain({ checkpoint, effects, now: 100 }),
        ).toBeUndefined();
        expect(admit).toHaveBeenCalledTimes(3);
        expect(applyCanonicalOrderUpdate).toHaveBeenCalledTimes(3);
        for (const effect of effects.slice(0, 3))
            expect(admit).toHaveBeenCalledWith({
                jobId: canonicalOrderEffectId(effect),
                payload: effect.payload,
                now: 100,
            });
        for (const effect of effects.slice(3))
            expect(applyCanonicalOrderUpdate).toHaveBeenCalledWith(
                effect.payload,
                checkpoint,
                100,
            );
    });

    it("rejects mixed-chain work before retaining any effects", () => {
        const applyCanonicalOrderUpdate = vi.fn();
        const admit = vi.fn<MakerRevalidationStore["admit"]>();
        const operation = new RetainCanonicalOrderEffects({
            orders: { applyCanonicalOrderUpdate },
            makers: { admit, scheduleWakeup: vi.fn() },
        });
        const effects = buildCanonicalOrderEffects(fixture());
        effects.at(-1)!.payload.chainId = 2;
        expect(() =>
            operation.retain({
                checkpoint: { chainId: CHAIN, revision: 0 },
                effects,
                now: 100,
            }),
        ).toThrow(ChainSyncConflict);
        expect(admit).not.toHaveBeenCalled();
        expect(applyCanonicalOrderUpdate).not.toHaveBeenCalled();
    });

    it("propagates retention failure so the enclosing core writer cannot publish readiness", () => {
        const failure = new Error("retention unavailable");
        const applyCanonicalOrderUpdate = vi.fn();
        const admit = vi
            .fn<MakerRevalidationStore["admit"]>()
            .mockImplementation(() => {
                throw failure;
            });
        const operation = new RetainCanonicalOrderEffects({
            orders: { applyCanonicalOrderUpdate },
            makers: { admit, scheduleWakeup: vi.fn() },
        });
        expect(() =>
            operation.retain({
                checkpoint: { chainId: CHAIN, revision: 0 },
                effects: buildCanonicalOrderEffects(fixture()),
                now: 100,
            }),
        ).toThrow(failure);
        expect(applyCanonicalOrderUpdate).not.toHaveBeenCalled();
    });
});
