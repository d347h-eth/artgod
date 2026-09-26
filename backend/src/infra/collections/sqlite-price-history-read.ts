import { db } from "@artgod/shared/database";
import { FILL_KIND } from "@artgod/shared/market-data/fills";
import type {
    PriceHistoryCurrencySymbol,
    RealizedSale,
} from "@artgod/shared/types/price-history";
import type { PriceHistoryReadPort } from "../../application/use-cases/collections/get-price-history.js";
import { realizedSaleExecution } from "../../domain/realized-price-history.js";
import {
    groupTraitFilters,
    groupTraitRangeFilters,
    normalizeTraitFilters,
    normalizeTraitRangeFilters,
    resolveTraitFilterTokenCandidates,
} from "@artgod/shared/read-models/trait-filters";

type FillRow = {
    id: number;
    block_timestamp: number;
    token_id: string;
    price: string;
    currency: string;
    order_side: string | null;
    maker: string | null;
    taker: string | null;
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
    ): Iterable<RealizedSale> {
        const candidates = resolveTraitFilterTokenCandidates({
            chainId: input.chainId,
            collectionId: input.collectionId,
            tokenId: input.tokenId,
            traitFilterGroups: groupTraitFilters(
                normalizeTraitFilters(input.traits ?? []),
            ),
            traitRangeFilterGroups: groupTraitRangeFilters(
                normalizeTraitRangeFilters(input.traitRanges ?? []),
            ),
        });
        if (candidates.isEmpty) return;
        // Legacy Seaport rows cannot prove a single NFT: an untracked sibling
        // leaves no fill row. Blur V2 has always quoted each exchange separately.
        const query = db.prepare(
            `SELECT id, block_timestamp, token_id, price, currency, tx_hash, order_side, maker, taker
             FROM fills
             WHERE chain_id = ? AND collection_id = ?
               AND block_timestamp >= ? AND block_timestamp < ?
               ${input.tokenId === undefined ? "" : "AND token_id = ?"}
               ${candidates.tokenIds === null ? "" : "AND token_id IN (SELECT value FROM json_each(?))"}
               AND amount = '1'
               AND (price_nft_count = '1' OR (price_nft_count IS NULL AND kind = ?))
               AND currency IN (${Array.from(this.currencies, () => "?").join(",")})
               AND price IS NOT NULL AND price != '' AND price NOT GLOB '*[^0-9]*'
               AND length(price) <= 78
             ORDER BY block_timestamp, block_number, log_index, id
             LIMIT ?`,
        );
        const args: (string | number)[] = [
            input.chainId,
            input.collectionId,
            input.from,
            input.to,
        ];
        if (input.tokenId !== undefined) args.push(input.tokenId);
        // One binding avoids SQLite's variable limit on large matching token sets.
        if (candidates.tokenIds !== null)
            args.push(JSON.stringify(candidates.tokenIds));
        args.push(FILL_KIND.BlurV2, ...this.currencies.keys(), input.limit);
        for (const raw of query.iterate(...args)) {
            const row = raw as FillRow;
            yield {
                id: String(row.id),
                timestamp: row.block_timestamp,
                tokenId: row.token_id,
                priceWei: row.price,
                currencyAddress: row.currency,
                // The SQL whitelist guarantees this configured execution symbol.
                currencySymbol: this.currencies.get(row.currency)!,
                ...realizedSaleExecution(row.order_side, row.maker, row.taker),
                txHash: row.tx_hash,
            };
        }
    }
}
