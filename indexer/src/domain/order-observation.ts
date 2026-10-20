import { keccak256, stringToHex } from "viem";
import { FILL_KIND } from "@artgod/shared/market-data/fills";
import {
    seaportOrderType,
    seaportIsNftItem,
    seaportIsCriteriaItem,
    SEAPORT_ORDER_TYPE,
} from "@artgod/shared/market-data/seaport";
import {
    computeSeaportOrderHash,
    resolveSeaportProtocolVersion,
} from "./seaport-protocol.js";
import {
    ORDER_SOURCE_STATUS,
    ORDER_SIDE,
    ORDER_SOURCE_SCOPE_KIND,
    type OrderRecord,
    type SeaportOrderData,
} from "./orders.js";

export const ORDER_OBSERVATION_KIND = {
    Declaration: "declaration",
    Update: "update",
} as const;

/** Clock values may distinguish retransmissions but never order local work or
 * establish a chain checkpoint. Callers pass normalized semantic fields only. */
export function orderObservationKey(
    source: string,
    kind: string,
    fields: readonly unknown[],
): string {
    if (!source || source.length > 256)
        throw new Error("Invalid order source identity");
    return `${source}:${kind}:${keccak256(stringToHex(JSON.stringify(fields)))}`;
}

/** Structural acceptance is separate from protocol/signature executability.
 * Missing/unsupported terms remain an observed declaration without RPC readiness. */
export function orderDeclarationReady(
    order: Pick<OrderRecord, "id" | "kind" | "maker" | "seaportData">,
): boolean {
    const terms = order.seaportData;
    if (order.kind !== FILL_KIND.Seaport || !terms) return false;
    try {
        resolveSeaportProtocolVersion(terms.protocolAddress);
        const type = seaportOrderType(terms.orderType);
        return (
            type !== null &&
            type !== SEAPORT_ORDER_TYPE.Contract &&
            terms.offer.length > 0 &&
            terms.consideration.length > 0 &&
            terms.offerer.toLowerCase() === order.maker.toLowerCase() &&
            computeSeaportOrderHash(terms).toLowerCase() ===
                order.id.toLowerCase()
        );
    } catch {
        return false;
    }
}

/** A fully supplied signed payload must identify this order before it can
 * become the immutable declaration retained for later validation. */
export function assertOrderDeclarationIdentity(
    order: Pick<
        OrderRecord,
        | "id"
        | "maker"
        | "side"
        | "contract"
        | "tokenId"
        | "sourceScopeKind"
        | "seaportData"
    >,
): void {
    if (!order.seaportData) return;
    if (
        computeSeaportOrderHash(order.seaportData).toLowerCase() !==
            order.id.toLowerCase() ||
        order.seaportData.offerer.toLowerCase() !== order.maker.toLowerCase()
    )
        throw new Error(
            "Signed declaration does not identify the observed order",
        );
    const nftItems = (
        order.side === ORDER_SIDE.Sell
            ? order.seaportData.offer
            : order.side === ORDER_SIDE.Buy
              ? order.seaportData.consideration
              : []
    ).filter(
        (item) =>
            seaportIsNftItem(item.itemType) &&
            item.token.toLowerCase() === order.contract.toLowerCase(),
    );
    // Ownership and maker invalidation use this normalized NFT identity. A
    // source cannot redirect those reads to another token while retaining a
    // valid signed hash. Criteria identifiers are roots, not exact token IDs;
    // their existing collection/attribute/token-set resolution remains separate.
    const matchesNft = nftItems.some((item) => {
        if (seaportIsCriteriaItem(item.itemType)) return true;
        if (
            (order.sourceScopeKind ?? ORDER_SOURCE_SCOPE_KIND.Token) !==
            ORDER_SOURCE_SCOPE_KIND.Token
        )
            return false;
        if (order.tokenId == null) return false;
        try {
            return BigInt(order.tokenId) === BigInt(item.identifierOrCriteria);
        } catch {
            return false;
        }
    });
    if (!matchesNft)
        throw new Error(
            "Signed declaration does not identify the observed NFT",
        );
}

export function sourceAvailabilityAfterObservation(
    previous: string | undefined,
    incoming:
        | (typeof ORDER_SOURCE_STATUS)[keyof typeof ORDER_SOURCE_STATUS]
        | null
        | undefined,
    declaration: boolean,
) {
    return declaration && previous === ORDER_SOURCE_STATUS.Cancelled
        ? ORDER_SOURCE_STATUS.Cancelled
        : (incoming ?? previous ?? ORDER_SOURCE_STATUS.Inactive);
}

/** One retained declaration cannot change protocol domain or signed components.
 * A missing signature can be enriched; a later source cannot replace one already retained. */
export function mergeOrderDeclaration(
    existing: SeaportOrderData | null,
    incoming: SeaportOrderData | null,
): SeaportOrderData | null {
    if (!incoming) return existing;
    if (!existing) return incoming;
    if (
        existing.protocolAddress.toLowerCase() !==
            incoming.protocolAddress.toLowerCase() ||
        computeSeaportOrderHash(existing).toLowerCase() !==
            computeSeaportOrderHash(incoming).toLowerCase()
    )
        throw new Error(
            "Order observation conflicts with retained signed declaration",
        );
    return existing.signature || !incoming.signature
        ? existing
        : { ...existing, signature: incoming.signature };
}

/** Withdrawal by one source cannot revoke availability published by another. */
export function aggregateOrderAvailability(hasActiveSource: boolean) {
    return hasActiveSource
        ? ORDER_SOURCE_STATUS.Active
        : ORDER_SOURCE_STATUS.Inactive;
}

/** Signed validity bounds belong to the immutable declaration, not a source's
 * mutable offer metadata. Unsafe timestamps cannot become lifecycle deadlines. */
export function orderDeclarationValidity(
    terms: SeaportOrderData | null | undefined,
): { validFrom: number; validUntil: number } | null {
    if (!terms) return null;
    const validFrom = Number(terms.startTime);
    const validUntil = Number(terms.endTime);
    if (
        !Number.isSafeInteger(validFrom) ||
        validFrom < 0 ||
        !Number.isSafeInteger(validUntil) ||
        validUntil <= validFrom
    )
        throw new Error("Signed declaration has unsupported validity bounds");
    return { validFrom, validUntil };
}
