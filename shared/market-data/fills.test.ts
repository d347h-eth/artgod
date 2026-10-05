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
    resolveFillNftSide,
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

it.each([SIDE.Offer, SIDE.Consideration])(
    "counts forwarded NFT units once on the %s leg while retaining all raw items",
    (soldSide) => {
        const items = [
            item(0, SIDE.Offer, TYPE.Erc721, "1", "a"),
            item(1, SIDE.Offer, TYPE.Erc1155, "2", "b"),
            item(
                2,
                soldSide === SIDE.Offer ? SIDE.Consideration : SIDE.Offer,
                TYPE.Native,
                "7",
            ),
            item(3, SIDE.Consideration, TYPE.Erc1155, "2", "b"),
            item(4, SIDE.Consideration, TYPE.Erc721, "1", "a"),
        ];
        const execution = { protocolAddress: "protocol", items };
        expect(resolveFillNftSide(items)).toBe(soldSide);
        const prepared = prepareFillExecution(execution);
        expect(prepared.payment).toEqual({
            exclusion: null,
            totalPrice: "7",
            currency: "eth",
            nftQuantity: "3",
        });
        expect(prepared.items.map(({ unitOffset, ...raw }) => raw)).toEqual(
            items,
        );
        const sold = prepared.items.filter(
            (item) => item.side === soldSide && item.itemType >= TYPE.Erc721,
        );
        const allocations = sold.map((item) =>
            allocateFillPayment("7", "3", item.amount, item.unitOffset),
        );
        expect(
            allocations.reduce((n, a) => n + BigInt(a.attributedPrice), 0n),
        ).toBe(7n);
        expect(allocations.map((a) => a.unitPrice)).toEqual([
            { numeratorWei: "7", denominator: "3" },
            { numeratorWei: "7", denominator: "3" },
        ]);
        const forwarded = items.find(
            (item) => item.side !== soldSide && item.itemType >= TYPE.Erc721,
        )!;
        expect(() =>
            fillAttributionItem(execution, forwarded.index, {
                contract: forwarded.contract,
                tokenId: forwarded.identifier,
                amount: forwarded.amount,
            }),
        ).toThrow("contradicts");
    },
);

it("requires the complete concrete forwarding multiset and payment on one side", () => {
    const nfts = [
        item(0, SIDE.Offer, TYPE.Erc721, "1", "tracked"),
        item(1, SIDE.Offer, TYPE.Erc1155, "2", "untracked"),
        item(2, SIDE.Consideration, TYPE.Erc721, "1", "tracked"),
        item(3, SIDE.Consideration, TYPE.Erc1155, "2", "untracked"),
    ];
    const payment = item(4, SIDE.Consideration, TYPE.Native, "7");
    for (const mutation of [
        { identifier: "2" },
        { amount: "3" },
        { contract: "different" },
        { itemType: TYPE.Criteria1155 },
    ]) {
        const items = [
            ...nfts.map((item, i) =>
                i === 3 ? { ...item, ...mutation } : item,
            ),
            payment,
        ];
        expect(resolveFillNftSide(items)).toBeNull();
        expect(summarizeFillPayment(items).exclusion).toBe(
            "itemType" in mutation
                ? EXCLUSION.UnsupportedItems
                : EXCLUSION.Swap,
        );
    }
    expect(resolveFillNftSide(nfts)).toBeNull();
    expect(
        resolveFillNftSide([
            ...nfts,
            payment,
            item(5, SIDE.Offer, TYPE.Native, "1"),
        ]),
    ).toBeNull();
    // Same lengths and total quantity cannot substitute for equal individual items.
    expect(
        resolveFillNftSide([
            nfts[0]!,
            { ...nfts[0]!, index: 1 },
            nfts[2]!,
            nfts[3]!,
            payment,
        ]),
    ).toBeNull();
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
