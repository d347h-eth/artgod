import { describe, expect, it } from "vitest";
import { SEAPORT_ITEM_TYPE } from "./seaport.js";
import { seaportNftQuantity } from "./seaport-quantity.js";

const COLLECTION = "0x1111111111111111111111111111111111111111";
const OTHER_COLLECTION = "0x2222222222222222222222222222222222222222";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const nft = {
    itemType: SEAPORT_ITEM_TYPE.Erc1155,
    token: COLLECTION,
    startAmount: "50",
};

describe("Seaport original NFT quantity", () => {
    it.each([
        undefined,
        null,
        1,
        "item",
        [],
        { token: COLLECTION, startAmount: "50" },
        { ...nft, itemType: null },
        { ...nft, itemType: "unknown" },
    ])(
        "rejects an unclassifiable member instead of reducing size (%j)",
        (item) => {
            expect(seaportNftQuantity([nft, item], COLLECTION)).toBeNull();
        },
    );

    it("counts all matching NFTs while excluding classified payments and other collections", () => {
        const items = [
            nft,
            {
                item_type: String(SEAPORT_ITEM_TYPE.Criteria1155),
                token: COLLECTION.toUpperCase(),
                start_amount: "25",
            },
            {
                itemType: SEAPORT_ITEM_TYPE.Erc20,
                token: WETH,
                startAmount: "6000000000000000000",
            },
            {
                itemType: SEAPORT_ITEM_TYPE.Native,
                token: "0x0000000000000000000000000000000000000000",
                startAmount: "100",
            },
            { ...nft, token: OTHER_COLLECTION },
        ];
        expect(seaportNftQuantity(items, COLLECTION)).toBe(75n);
        expect(seaportNftQuantity(items)).toBe(125n);
        expect(seaportNftQuantity(items, OTHER_COLLECTION)).toBe(50n);
    });

    it("does not invent signed units for an absent item array", () => {
        expect(seaportNftQuantity(undefined)).toBe(0n);
        expect(seaportNftQuantity([])).toBe(0n);
    });
});
