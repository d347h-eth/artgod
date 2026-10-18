import {
    seaportAllowsPartialFills,
    seaportRequiresFullFill,
    seaportIsNftItem,
    SEAPORT_ITEM_TYPE,
} from "@artgod/shared/market-data/seaport";
import { seaportNftQuantity } from "@artgod/shared/market-data/seaport-quantity";
import { FILL_KIND } from "@artgod/shared/market-data/fills";
import {
    ORDER_SIDE,
    ORDER_STATUS,
    type OrderRecord,
    type OrderValidationResult,
} from "./orders.js";

/** The current buy-order model supports one collection and a fixed unit price.
 * Do not publish quantity estimates for baskets or changing signed amounts. */
export function partialBuyOriginalQuantity(
    order: Pick<OrderRecord, "side" | "contract" | "seaportData" | "currency">,
): bigint | null {
    const data = order.seaportData;
    if (
        order.side !== ORDER_SIDE.Buy ||
        !data ||
        !seaportAllowsPartialFills(data.orderType)
    )
        return null;
    const nfts = data.consideration.filter((item) =>
        seaportIsNftItem(item.itemType),
    );
    if (
        nfts.length !== 1 ||
        nfts.some(
            (item) =>
                item.token.toLowerCase() !== order.contract.toLowerCase() ||
                item.startAmount !== item.endAmount,
        )
    )
        return null;
    const items = [...data.offer, ...data.consideration];
    if (
        data.offer.length !== 1 ||
        Number(data.offer[0]?.itemType) !== SEAPORT_ITEM_TYPE.Erc20 ||
        (order.currency &&
            data.offer[0].token.toLowerCase() !==
                order.currency.toLowerCase()) ||
        items.some((item) => item.startAmount !== item.endAmount)
    )
        return null;
    const quantity = seaportNftQuantity(nfts, order.contract);
    // Each NFT unit must be a valid Seaport fraction of every signed item.
    // Otherwise the minimum executable lot can exceed one NFT.
    return quantity !== null &&
        quantity > 0n &&
        items.every((item) => BigInt(item.startAmount) % quantity === 0n)
        ? quantity
        : null;
}

/** getOrderStatus stores a fraction, whose denominator need not equal NFT units. */
export function remainingOrderQuantity(
    original: bigint,
    filled: bigint,
    size: bigint,
): bigint {
    if (
        filled < 0n ||
        size < 0n ||
        (size === 0n && filled !== 0n) ||
        filled > size
    )
        throw new Error("Invalid Seaport filled fraction");
    if (size === 0n) return original;
    const numerator = original * (size - filled);
    if (numerator % size !== 0n)
        throw new Error("Non-integral Seaport NFT remainder");
    return numerator / size;
}

/** Full-only signed orders are exhausted by one canonical execution.
 * Partial or unknown Seaport terms need a current protocol fraction; the
 * execution alone cannot establish cumulative remaining inventory. */
export function fillExecutionNeedsValidation(order: OrderRecord): boolean {
    return (
        order.kind === FILL_KIND.Seaport &&
        !seaportRequiresFullFill(order.seaportData?.orderType)
    );
}

/** Per-order capacity at one snapshot. This does not reserve funds across offers. */
export function fundedOrderQuantity(
    remaining: bigint,
    unitPrice: bigint,
    balance: bigint,
    allowance: bigint = balance,
): bigint {
    if (unitPrice <= 0n)
        throw new Error("Capacity requires a positive unit price");
    return [remaining, balance / unitPrice, allowance / unitPrice].reduce(
        (a, b) => (a < b ? a : b),
    );
}

/** Immutable declared units are independent of an observed filled fraction. */
export function declaredOrderQuantity(
    order: Pick<OrderRecord, "side" | "contract" | "seaportData">,
): string | null {
    const data = order.seaportData;
    if (!data) return null;
    const items =
        order.side === ORDER_SIDE.Buy
            ? data.consideration
            : order.side === ORDER_SIDE.Sell
              ? data.offer
              : [];
    const quantity = seaportNftQuantity(items, order.contract);
    return quantity !== null && quantity > 0n ? quantity.toString() : null;
}

/** Terminal protocol state establishes zero capacity independently of shape. */
export function validatedQuantityUpdate(
    result: Pick<OrderValidationResult, "status" | "quantities">,
): {
    original: string | null;
    remaining: string | null;
    fillable: string | null;
} {
    return {
        original: result.quantities?.original ?? null,
        remaining:
            result.quantities?.remaining ??
            (result.status === ORDER_STATUS.Filled ? "0" : null),
        fillable:
            result.quantities?.fillable ??
            ([
                ORDER_STATUS.Filled,
                ORDER_STATUS.Cancelled,
                ORDER_STATUS.NoBalance,
                ORDER_STATUS.NoApproval,
            ].some((status) => status === result.status)
                ? "0"
                : null),
    };
}
