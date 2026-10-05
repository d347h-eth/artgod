import { FILL_PRICE_BASIS } from "../market-data/fills.js";
import type { RealizedSale } from "../types/price-history.js";

/** Single-unit DTO fixture; bundle tests supply their explicit execution facts. */
export function pricedSaleFixture(
    price: string,
    executionId: string,
): Pick<
    RealizedSale,
    | "unitPrice"
    | "executionId"
    | "quantity"
    | "attributedPriceWei"
    | "executionTotalWei"
    | "executionNftQuantity"
    | "priceBasis"
> {
    return {
        unitPrice: { numeratorWei: price, denominator: "1" },
        executionId,
        quantity: "1",
        attributedPriceWei: price,
        executionTotalWei: price,
        executionNftQuantity: "1",
        priceBasis: FILL_PRICE_BASIS.Unit,
    };
}
