import { db } from "@artgod/shared/database";
import { FILL_KIND } from "@artgod/shared/market-data/fills";
import type { PriceHistoryReadPort } from "../../application/use-cases/collections/get-price-history.js";
import type { PricedFill } from "../../domain/realized-price-history.js";

type FillRow = {
    id: number;
    block_timestamp: number;
    block_number: number;
    log_index: number;
    token_id: string;
    price: string;
    tx_hash: string;
};

export class SqlitePriceHistoryRead implements PriceHistoryReadPort {
    constructor(private readonly ethCurrencies: readonly string[]) {}

    *iterateSingleTokenSales(
        input: Parameters<PriceHistoryReadPort["iterateSingleTokenSales"]>[0],
    ): Iterable<PricedFill> {
        // Legacy Seaport rows cannot prove a single NFT: an untracked sibling
        // leaves no fill row. Blur V2 has always quoted each exchange separately.
        const query = db.prepare(
            `SELECT id, block_timestamp, block_number, log_index, token_id, price, tx_hash
             FROM fills
             WHERE chain_id = ? AND collection_id = ?
               AND block_timestamp >= ? AND block_timestamp < ?
               ${input.tokenId === undefined ? "" : "AND token_id = ?"}
               AND amount = '1'
               AND (price_nft_count = '1' OR (price_nft_count IS NULL AND kind = ?))
               AND currency IN (${this.ethCurrencies.map(() => "?").join(",")})
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
            ...this.ethCurrencies.map((currency) => currency.toLowerCase()),
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
                txHash: row.tx_hash,
            };
        }
    }
}
