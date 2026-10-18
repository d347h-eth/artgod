import { toBigInt } from "../offchain/normalizer-utils.js";
/** Seaport ABI values shared by signed orders and execution items. */
export const SEAPORT_ITEM_TYPE = {
    Native: 0,
    Erc20: 1,
    Erc721: 2,
    Erc1155: 3,
    Criteria721: 4,
    Criteria1155: 5,
} as const;
export const SEAPORT_ORDER_TYPE = {
    FullOpen: 0,
    PartialOpen: 1,
    FullRestricted: 2,
    PartialRestricted: 3,
    Contract: 4,
} as const;

/** Named enum values accepted at marketplace SDK boundaries. */
export const SEAPORT_ORDER_TYPE_NAME = {
    FullOpen: "FULL_OPEN",
    PartialOpen: "PARTIAL_OPEN",
    FullRestricted: "FULL_RESTRICTED",
    PartialRestricted: "PARTIAL_RESTRICTED",
    Contract: "CONTRACT",
} as const;
const orderTypesByName = new Map(
    Object.entries(SEAPORT_ORDER_TYPE).map(([name, value]) => [
        SEAPORT_ORDER_TYPE_NAME[name as keyof typeof SEAPORT_ORDER_TYPE_NAME],
        value,
    ]),
);
const itemTypes = new Set<number>(Object.values(SEAPORT_ITEM_TYPE));
const orderTypes = new Set<number>(Object.values(SEAPORT_ORDER_TYPE));

function protocolUint(value: unknown): number | null {
    try {
        const number = Number(toBigInt(value, "Seaport enum"));
        return Number.isSafeInteger(number) && number >= 0 ? number : null;
    } catch {
        return null;
    }
}
export function seaportOrderType(value: unknown): number | null {
    if (typeof value === "string") {
        const named = orderTypesByName.get(
            value.toUpperCase() as (typeof SEAPORT_ORDER_TYPE_NAME)[keyof typeof SEAPORT_ORDER_TYPE_NAME],
        );
        if (named !== undefined) return named;
    }
    const type = protocolUint(value);
    return type !== null && orderTypes.has(type) ? type : null;
}
export function seaportItemType(value: unknown): number | null {
    const type = protocolUint(value);
    return type !== null && itemTypes.has(type) ? type : null;
}
export function seaportAllowsPartialFills(value: unknown): boolean {
    const type = seaportOrderType(value);
    return (
        type === SEAPORT_ORDER_TYPE.PartialOpen ||
        type === SEAPORT_ORDER_TYPE.PartialRestricted
    );
}
export function seaportRequiresFullFill(value: unknown): boolean {
    const type = seaportOrderType(value);
    return (
        type === SEAPORT_ORDER_TYPE.FullOpen ||
        type === SEAPORT_ORDER_TYPE.FullRestricted
    );
}
export function seaportIsNftItem(value: unknown): boolean {
    const type = seaportItemType(value);
    return (
        type === SEAPORT_ITEM_TYPE.Erc721 ||
        type === SEAPORT_ITEM_TYPE.Erc1155 ||
        type === SEAPORT_ITEM_TYPE.Criteria721 ||
        type === SEAPORT_ITEM_TYPE.Criteria1155
    );
}
export function seaportIsCriteriaItem(value: unknown): boolean {
    const type = seaportItemType(value);
    return (
        type === SEAPORT_ITEM_TYPE.Criteria721 ||
        type === SEAPORT_ITEM_TYPE.Criteria1155
    );
}
export function seaportIsConcreteNftItem(value: unknown): boolean {
    const type = seaportItemType(value);
    return (
        type === SEAPORT_ITEM_TYPE.Erc721 || type === SEAPORT_ITEM_TYPE.Erc1155
    );
}
export function seaportIsPaymentItem(value: unknown): boolean {
    const type = seaportItemType(value);
    return (
        type === SEAPORT_ITEM_TYPE.Native || type === SEAPORT_ITEM_TYPE.Erc20
    );
}
