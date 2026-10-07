import { expect, it } from "vitest";
import {
    allocateFillPayment,
    compareUnitPrices,
    FILL_ITEM_SIDE as SIDE,
    FILL_ITEM_TYPE as TYPE,
    FILL_PRICE_BASIS as BASIS,
    FILL_PRICE_EXCLUSION as EXCLUSION,
    summarizeFillPayment,
    prepareFillExecution,
    fillAttributionItem,
    type FillExecutionItem,
} from "./fills.js";
const item = (
    index: number,
    side: FillExecutionItem["side"],
    itemType: number,
    amount: string,
    contract = "eth",
): FillExecutionItem => ({
    index,
    side,
    itemType,
    amount,
    contract,
    identifier: "1",
    recipient: null,
});

it("classifies full cash, cross-collection, swap and mixed-payment executions", () => {
    const cash = [
        item(0, SIDE.Offer, TYPE.Erc721, "1", "tracked"),
        item(1, SIDE.Offer, TYPE.Erc1155, "2", "untracked"),
        item(2, SIDE.Consideration, TYPE.Native, "6"),
    ];
    expect(summarizeFillPayment(cash)).toEqual({
        exclusion: null,
        totalPrice: "6",
        currency: "eth",
        nftQuantity: "3",
    });
    expect(
        summarizeFillPayment([
            ...cash,
            item(3, SIDE.Consideration, TYPE.Erc721, "1"),
        ]).exclusion,
    ).toBe(EXCLUSION.Swap);
    expect(
        summarizeFillPayment([...cash, item(3, SIDE.Offer, TYPE.Native, "1")])
            .exclusion,
    ).toBe(EXCLUSION.MixedPayment);
    expect(
        summarizeFillPayment([
            ...cash,
            item(3, SIDE.Consideration, TYPE.Erc20, "1", "erc20"),
        ]).exclusion,
    ).toBe(EXCLUSION.MixedPayment);
    expect(summarizeFillPayment(cash.slice(0, 2)).exclusion).toBe(
        EXCLUSION.NoPayment,
    );
    expect(
        summarizeFillPayment([
            ...cash,
            item(3, SIDE.Offer, TYPE.Criteria721, "1"),
        ]).exclusion,
    ).toBe(EXCLUSION.UnsupportedItems);
    expect(() =>
        summarizeFillPayment([item(0, SIDE.Offer, TYPE.Erc721, "0")]),
    ).toThrow("quantity");
    expect(
        summarizeFillPayment([
            item(0, SIDE.Offer, TYPE.Erc20, "10"),
            item(1, SIDE.Consideration, TYPE.Erc721, "1"),
            item(2, SIDE.Consideration, TYPE.Erc20, "2"),
        ]),
    ).toEqual({
        exclusion: null,
        totalPrice: "10",
        currency: "eth",
        nftQuantity: "1",
    });
});

it("conserves every wei without changing any unit price or reassigning filtered remainders", () => {
    const pieces = [
        allocateFillPayment("1", "3", "1", "0"),
        allocateFillPayment("1", "3", "2", "1"),
    ];
    expect(pieces.map((p) => p.attributedPrice)).toEqual(["1", "0"]);
    expect(pieces.map((p) => p.unitPrice)).toEqual([
        { numeratorWei: "1", denominator: "3" },
        { numeratorWei: "1", denominator: "3" },
    ]);
    expect(pieces[0]!.priceBasis).toBe(BASIS.BundleAverage);
    expect(allocateFillPayment("6", "3", "3", "0").priceBasis).toBe(BASIS.Unit);
    for (let total = 0n; total < 100n; total++) {
        const amounts = [
            allocateFillPayment(String(total), "7", "2", "0"),
            allocateFillPayment(String(total), "7", "4", "2"),
            allocateFillPayment(String(total), "7", "1", "6"),
        ];
        expect(
            amounts.reduce((n, p) => n + BigInt(p.attributedPrice), 0n),
        ).toBe(total);
    }
    expect(() => allocateFillPayment("1", "3", "2", "2")).toThrow("allocation");
    expect(
        compareUnitPrices(
            { numeratorWei: "9007199254740993", denominator: "3" },
            { numeratorWei: "9007199254740992", denominator: "3" },
        ),
    ).toBe(1);
    expect(
        compareUnitPrices(
            { numeratorWei: "2", denominator: "6" },
            { numeratorWei: "1", denominator: "3" },
        ),
    ).toBe(0);
});

it("validates item identities and collection attribution in the owning domain", () => {
    const execution = {
        protocolAddress: "protocol",
        items: [
            item(0, SIDE.Offer, TYPE.Erc1155, "2", "a"),
            item(1, SIDE.Offer, TYPE.Erc721, "1", "b"),
            item(2, SIDE.Consideration, TYPE.Native, "5"),
        ],
    };
    expect(
        prepareFillExecution(execution).items.map((i) => i.unitOffset),
    ).toEqual(["0", "2", "3"]);
    expect(
        fillAttributionItem(execution, 1, {
            contract: "b",
            tokenId: "1",
            amount: "1",
        }),
    ).toBe(execution.items[1]);
    expect(() =>
        fillAttributionItem(execution, 1, {
            contract: "b",
            tokenId: "2",
            amount: "1",
        }),
    ).toThrow("contradicts");
    expect(() =>
        prepareFillExecution({
            ...execution,
            items: [{ ...execution.items[0]!, index: 1 }],
        }),
    ).toThrow("identity");
    expect(() =>
        prepareFillExecution({
            ...execution,
            items: [{ ...execution.items[0]!, amount: "-2" }],
        }),
    ).toThrow("amount");
});
