import { ORDERBOOK_VENUE } from "@artgod/shared/market-data/orders";
import type { BookMarket } from "../../domain/orderbook.js";

export const VVV_MARKET: BookMarket = {
    venue: ORDERBOOK_VENUE.Vvv,
    chainId: 1,
    reference: "111k",
    contract: "0x08cded8258730bda384ff198001e47a1b50f7f9d",
};

/** Locations verified for each public market. Local collection names never supply a URL. */
export interface VvvMarketLocation {
    market: BookMarket;
    readerUrl: string;
    bookUrl: string;
}

export const VVV_MARKETS: readonly VvvMarketLocation[] = [
    {
        market: VVV_MARKET,
        readerUrl: "https://www.vvv.so/api/111k/artists",
        bookUrl: "https://www.vvv.so/api/111k/state?orders=1",
    },
];
