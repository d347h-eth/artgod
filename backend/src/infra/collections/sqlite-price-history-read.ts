import { db } from "@artgod/shared/database";
import {
    allocateFillPayment,
    FILL_PRICE_EXCLUSION,
    type FillPriceExclusion,
} from "@artgod/shared/market-data/fills";
import type {
    PriceHistoryCurrencySymbol,
    PriceHistoryObservation,
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
    total_price: string | null;
    currency: string | null;
    execution_id: string;
    amount: string;
    nft_quantity: string;
    unit_offset: string;
    price_exclusion: FillPriceExclusion | null;
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

    *iterateObservations(
        input: Parameters<PriceHistoryReadPort["iterateObservations"]>[0],
    ): Iterable<PriceHistoryObservation> {
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
        // Indexed chronology reads each attributed item once. Header totals and
        // raw-item offsets already include untracked/cross-collection siblings.
        const query = db.prepare(
            `SELECT f.id, f.block_timestamp, f.token_id, f.amount, f.execution_id, e.total_price, e.currency, e.nft_quantity, e.price_exclusion, i.unit_offset, f.tx_hash, f.order_side, f.maker, f.taker
             FROM fills f
             JOIN fill_executions e ON e.id=f.execution_id
             JOIN fill_execution_items i ON i.execution_id=f.execution_id AND i.item_index=f.item_index
             WHERE f.chain_id = ? AND f.collection_id = ?
               AND f.block_timestamp >= ? AND f.block_timestamp < ?
               ${input.tokenId === undefined ? "" : "AND f.token_id = ?"}
               ${candidates.tokenIds === null ? "" : "AND f.token_id IN (SELECT value FROM json_each(?))"}
             ORDER BY f.block_timestamp, f.block_number, f.log_index, f.id
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
        args.push(input.limit);
        for (const raw of query.iterate(...args)) {
            const row = raw as FillRow;
            const identity = {
                id: String(row.id),
                timestamp: row.block_timestamp,
                tokenId: row.token_id,
                quantity: row.amount,
                executionId: row.execution_id,
            };
            const currencySymbol =
                row.currency === null
                    ? undefined
                    : this.currencies.get(row.currency);
            const exclusionReason =
                row.price_exclusion ??
                (currencySymbol
                    ? null
                    : FILL_PRICE_EXCLUSION.UnsupportedCurrency);
            if (exclusionReason) {
                yield { ...identity, exclusionReason };
                continue;
            }
            const allocation = allocateFillPayment(
                row.total_price!,
                row.nft_quantity,
                row.amount,
                row.unit_offset,
            );
            yield {
                ...identity,
                unitPrice: allocation.unitPrice,
                attributedPriceWei: allocation.attributedPrice,
                priceBasis: allocation.priceBasis,
                executionTotalWei: row.total_price!,
                executionNftQuantity: row.nft_quantity,
                currencyAddress: row.currency!,
                currencySymbol: currencySymbol!,
                ...realizedSaleExecution(row.order_side, row.maker, row.taker),
                txHash: row.tx_hash,
            };
        }
    }
}
