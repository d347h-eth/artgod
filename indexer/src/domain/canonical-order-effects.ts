import type { ChainSyncCheckpoint } from "./chain-sync.js";
import type { CollectionRecord } from "./collections.js";
import type { ChainAttribution, OnChainData } from "./onchain.js";
import {
    MAKER_TRIGGER_SCOPE,
    ORDER_JOB_KIND,
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
} from "./order-jobs.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    type BackfillOrderMaintenancePolicy,
} from "./sync-jobs.js";

/** Only accepted chain events enter this contract. Source observations use their
 * own admission path and cannot supply these protocol effects. */
export type CanonicalOrderUpdate = Pick<
    OrderUpdateByIdPayload,
    "chainId" | "orderId"
> &
    ChainAttribution & {
        reason:
            | typeof ORDER_UPDATE_REASON.Fill
            | typeof ORDER_UPDATE_REASON.Cancel
            | typeof ORDER_UPDATE_REASON.Validation;
    };

export type CanonicalMakerUpdate = OrderUpdateByMakerPayload & ChainAttribution;
export type CanonicalOrderEffect =
    | { kind: typeof ORDER_JOB_KIND.UpdateById; payload: CanonicalOrderUpdate }
    | {
          kind: typeof ORDER_JOB_KIND.UpdateByMaker;
          payload: CanonicalMakerUpdate;
      };
export type CanonicalOrderEffectsInput = {
    checkpoint: ChainSyncCheckpoint;
    effects: readonly CanonicalOrderEffect[];
    now: number;
};

/** The coordinator supplies only collections whose current prefix it is applying.
 * Anchor checks remain domain-owned; acquired historical facts alone never
 * create current order effects. The same classification drives optional fanout. */
export function buildCanonicalOrderEffects(input: {
    chainId: number;
    collections: readonly CollectionRecord[];
    data: OnChainData;
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy;
    /** Shared protocol effects belong to shared advancement, independently of
     * collection readiness. Collection-only catch-up cannot replay them. */
    applyingShared: boolean;
}): CanonicalOrderEffect[] {
    if (
        input.orderMaintenancePolicy !==
        BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState
    )
        return [];
    const { chainId, data } = input;
    const currentCollections = input.collections.filter(
        (collection) => collection.chainId === chainId,
    );
    const collections = new Map(
        currentCollections.map((collection) => [collection.id, collection]),
    );
    const current = (collectionId: number, number: number) =>
        collections.get(collectionId)?.canProjectCurrentStateAt(number) ??
        false;
    const effects: CanonicalOrderEffect[] = [];
    for (const trigger of data.collectionScoped.makerTriggers) {
        if (!current(trigger.collectionId, trigger.blockNumber)) continue;
        effects.push({
            kind: ORDER_JOB_KIND.UpdateByMaker,
            payload:
                "tokenId" in trigger
                    ? {
                          ...trigger,
                          chainId,
                          maker: trigger.maker.toLowerCase(),
                          scope: MAKER_TRIGGER_SCOPE.Token,
                      }
                    : {
                          ...trigger,
                          chainId,
                          maker: trigger.maker.toLowerCase(),
                          scope: MAKER_TRIGGER_SCOPE.Collection,
                      },
        });
    }
    for (const trigger of data.global.makerTriggers) {
        if (!input.applyingShared) continue;
        effects.push({
            kind: ORDER_JOB_KIND.UpdateByMaker,
            payload: {
                ...trigger,
                chainId,
                maker: trigger.maker.toLowerCase(),
                scope: MAKER_TRIGGER_SCOPE.Global,
            },
        });
    }
    const orderEffect = (
        orderId: string,
        reason: CanonicalOrderUpdate["reason"],
        attribution: ChainAttribution,
    ) => {
        effects.push({
            kind: ORDER_JOB_KIND.UpdateById,
            payload: {
                chainId,
                orderId,
                reason,
                blockNumber: attribution.blockNumber,
                blockHash: attribution.blockHash,
                txHash: attribution.txHash,
                logIndex: attribution.logIndex,
            },
        });
    };
    for (const fill of data.collectionScoped.fillEvents)
        if (fill.orderId && current(fill.collectionId, fill.blockNumber))
            orderEffect(fill.orderId, ORDER_UPDATE_REASON.Fill, fill);
    for (const cancel of data.global.cancelEvents)
        if (cancel.orderId && input.applyingShared)
            orderEffect(cancel.orderId, ORDER_UPDATE_REASON.Cancel, cancel);
    for (const order of data.collectionScoped.orderInfos)
        if (order.orderId && current(order.collectionId, order.blockNumber))
            orderEffect(order.orderId, ORDER_UPDATE_REASON.Validation, order);
    return effects;
}

/** Stable identity lets direct durable admission and a replayed optional wakeup
 * refer to the same effect, including after a lost publication reply. */
export function canonicalOrderEffectId(effect: CanonicalOrderEffect): string {
    if (effect.kind === ORDER_JOB_KIND.UpdateById) {
        const payload = effect.payload;
        return `orders:update:id:${payload.chainId}:${payload.orderId}:${payload.blockNumber}:${payload.logIndex}:${payload.blockHash}`;
    }
    const maker = effect.payload;
    const prefix = `orders:update:maker:${maker.chainId}:${maker.maker.toLowerCase()}`;
    const suffix = `${maker.blockNumber}:${maker.logIndex}:${maker.blockHash}`;
    if (maker.scope === MAKER_TRIGGER_SCOPE.Global)
        return `${prefix}:global:${maker.reason}:${suffix}`;
    if (maker.scope === MAKER_TRIGGER_SCOPE.Token)
        return `${prefix}:${maker.collectionId}:${maker.tokenId}:${suffix}`;
    return `${prefix}:${maker.collectionId}:collection:${maker.reason}:${suffix}`;
}
