import { zeroAddress } from "viem";
import {
    seaportAllowsPartialFills,
    seaportRequiresFullFill,
    seaportIsNftItem,
    seaportIsPaymentItem,
    SEAPORT_ITEM_TYPE,
} from "@artgod/shared/market-data/seaport";
import { seaportNftQuantity } from "@artgod/shared/market-data/seaport-quantity";
import {
    ORDER_SIDE,
    ORDER_STATUS,
    type OrderRecord,
    type OrderValidationResult,
    type SeaportOrderItem,
} from "./orders.js";

/** One fixed NFT item has an unambiguous signed size on either order side.
 * Baskets and changing amounts remain unknown. Partial quantities require every
 * signed amount to permit a one-NFT fraction, matching the unit-capacity model. */
export function fixedOrderOriginalQuantity(
    order: Pick<OrderRecord, "side" | "contract" | "seaportData">,
): bigint | null {
    const data = order.seaportData;
    if (
        !data ||
        (!seaportAllowsPartialFills(data.orderType) &&
            !seaportRequiresFullFill(data.orderType))
    )
        return null;
    const nftItems = (
        order.side === ORDER_SIDE.Buy
            ? data.consideration
            : order.side === ORDER_SIDE.Sell
              ? data.offer
              : []
    ).filter((item) => seaportIsNftItem(item.itemType));
    const items = [...data.offer, ...data.consideration];
    if (
        nftItems.length !== 1 ||
        nftItems[0]!.token.toLowerCase() !== order.contract.toLowerCase() ||
        items.some((item) => item.startAmount !== item.endAmount)
    )
        return null;
    const declared = declaredOrderQuantity(order);
    if (declared === null) return null;
    const quantity = BigInt(declared);
    if (
        seaportAllowsPartialFills(data.orderType) &&
        items.some((item) => BigInt(item.startAmount) % quantity !== 0n)
    )
        return null;
    return quantity;
}

/** Signed payment required by the supported single-currency buy shape. A full
 * order requires its entire payment even if a normalized unit price is smaller. */
export function buyOrderFundingRequirement(
    order: Pick<OrderRecord, "side" | "seaportData">,
    original: bigint | null,
): { currency: string; minimumFunds: bigint; partial: boolean } | null {
    const data = order.seaportData;
    const payment = data ? fixedCurrencyPayment(data.offer) : null;
    if (
        order.side !== ORDER_SIDE.Buy ||
        !data ||
        data.offer.length !== 1 ||
        !payment
    )
        return null;
    const total = payment.amount;
    const partial =
        original !== null && seaportAllowsPartialFills(data.orderType);
    if (
        original !== null &&
        (original <= 0n || (partial && total % original !== 0n))
    )
        return null;
    return {
        currency: payment.currency,
        minimumFunds: partial ? total / original! : total,
        partial,
    };
}

/** The indexed quote belongs to signed fixed terms. Unknown quantities or
 * non-integral unit prices cannot borrow a source's claimed executable price. */
export function declaredOrderQuote(
    order: Pick<OrderRecord, "side" | "contract" | "seaportData">,
): { currency: string | null; price: string | null } {
    const data = order.seaportData;
    const payment =
        data && (order.side !== ORDER_SIDE.Buy || data.offer.length === 1)
            ? fixedCurrencyPayment(
                  order.side === ORDER_SIDE.Buy
                      ? data.offer
                      : data.consideration,
              )
            : null;
    const quantity = fixedOrderOriginalQuantity(order);
    return {
        currency: payment?.currency ?? null,
        price:
            payment && quantity !== null && payment.amount % quantity === 0n
                ? (payment.amount / quantity).toString()
                : null,
    };
}

/** One fixed payment currency, including fees split among recipients. */
function fixedCurrencyPayment(
    items: readonly SeaportOrderItem[],
): { currency: string; amount: bigint } | null {
    if (!items.length) return null;
    let currency: string | null = null;
    let amount = 0n;
    for (const item of items) {
        if (
            !seaportIsPaymentItem(item.itemType) ||
            item.startAmount !== item.endAmount
        )
            return null;
        const token =
            Number(item.itemType) === SEAPORT_ITEM_TYPE.Native
                ? zeroAddress
                : item.token.toLowerCase();
        if (currency !== null && currency !== token) return null;
        const value = BigInt(item.startAmount);
        if (value < 0n) return null;
        currency = token;
        amount += value;
    }
    return amount > 0n ? { currency: currency!, amount } : null;
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
