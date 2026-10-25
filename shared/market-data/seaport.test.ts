import { describe, expect, it } from "vitest";
import {
    SEAPORT_ITEM_TYPE,
    SEAPORT_ORDER_TYPE,
    SEAPORT_ORDER_TYPE_NAME,
    seaportItemType,
    seaportOrderType,
    seaportAllowsPartialFills,
    seaportRequiresFullFill,
    seaportIsNftItem,
    seaportIsPaymentItem,
} from "./seaport.js";

describe("Seaport protocol vocabulary", () => {
    it.each(Object.entries(SEAPORT_ORDER_TYPE))(
        "normalizes numeric and SDK order type %s",
        (name, value) => {
            expect(seaportOrderType(value)).toBe(value);
            expect(seaportOrderType(String(value))).toBe(value);
            expect(seaportOrderType(BigInt(value))).toBe(value);
            expect(
                seaportOrderType(
                    SEAPORT_ORDER_TYPE_NAME[
                        name as keyof typeof SEAPORT_ORDER_TYPE_NAME
                    ],
                ),
            ).toBe(value);
            const partial =
                value === SEAPORT_ORDER_TYPE.PartialOpen ||
                value === SEAPORT_ORDER_TYPE.PartialRestricted;
            expect(seaportAllowsPartialFills(value)).toBe(partial);
            expect(seaportRequiresFullFill(value)).toBe(
                !partial && value !== SEAPORT_ORDER_TYPE.Contract,
            );
        },
    );
    it.each(Object.values(SEAPORT_ITEM_TYPE))(
        "normalizes item type %s without losing its role",
        (value) => {
            expect(seaportItemType(String(value))).toBe(value);
            expect(seaportItemType(BigInt(value))).toBe(value);
            expect(seaportIsNftItem(value)).toBe(!seaportIsPaymentItem(value));
        },
    );
    it.each([null, undefined, true, false, "", {}, "PARTIAL_OTHER", -1, 0.5])(
        "rejects invalid protocol enum %s",
        (value) => {
            expect(seaportOrderType(value)).toBeNull();
            expect(seaportItemType(value)).toBeNull();
            expect(seaportAllowsPartialFills(value)).toBe(false);
            expect(seaportIsNftItem(value)).toBe(false);
        },
    );
});
