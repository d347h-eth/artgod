import { db } from "@artgod/shared/database";
import { FILL_KIND } from "@artgod/shared/market-data/fills";
import type { PriceHistoryCurrencySymbol } from "@artgod/shared/types/price-history";
import type { PriceHistoryReadPort } from "../../application/use-cases/collections/get-price-history.js";
import type { PricedFill } from "../../domain/realized-price-history.js";

type FillRow = {
    id: number;
    block_timestamp: number;
    block_number: number;
    log_index: number;
    token_id: string;
    price: string;
    currency: string;
    tx_hash: string;
};

export class SqlitePriceHistoryRead implements PriceHistoryReadPort {
    private readonly currencies: ReadonlyMap<
        string,
        PriceHistoryCurrencySymbol
    >;

    constructor(
        currencies: readonly {
            address: string;
            symbol: PriceHistoryCurrencySymbol;
        }[],
    ) {
        this.currencies = new Map(
            currencies.map(({ address, symbol }) => [
                address.toLowerCase(),
                symbol,
            ]),
        );
    }

    *iterateSingleTokenSales(
        input: Parameters<PriceHistoryReadPort["iterateSingleTokenSales"]>[0],
    ): Iterable<PricedFill> {
        // Legacy Seaport rows cannot prove a single NFT: an untracked sibling
        // leaves no fill row. Blur V2 has always quoted each exchange separately.
        const query = db.prepare(
            `SELECT id, block_timestamp, block_number, log_index, token_id, price, currency, tx_hash
             FROM fills
             WHERE chain_id = ? AND collection_id = ?
               AND block_timestamp >= ? AND block_timestamp < ?
               ${input.tokenId === undefined ? "" : "AND token_id = ?"}
               AND amount = '1'
               AND (price_nft_count = '1' OR (price_nft_count IS NULL AND kind = ?))
               AND currency IN (${Array.from(this.currencies, () => "?").join(",")})
               AND price IS NOT NULL AND price != '' AND price NOT GLOB '*[^0-9]*'
               AND length(price) <= 78
             LIMIT ?`,
        );
        const args: (string | number)[] = [
            input.chainId,
            input.collectionId,
            input.from,
            input.to,
        ];
        if (input.tokenId !== undefined) args.push(input.tokenId);
        args.push(
            FILL_KIND.BlurV2,
            ...this.currencies.keys(),
            input.limit,
        );
        for (const raw of query.iterate(...args)) {
            const row = raw as FillRow;
            yield {
                id: String(row.id),
                timestamp: row.block_timestamp,
                blockNumber: row.block_number,
                logIndex: row.log_index,
                tokenId: row.token_id,
                priceWei: row.price,
                currencyAddress: row.currency,
                // The SQL whitelist guarantees this configured execution symbol.
                currencySymbol: this.currencies.get(row.currency)!,
                txHash: row.tx_hash,
            };
        }
    }
}
