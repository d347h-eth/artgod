import {
    FILL_KIND,
    FILL_ITEM_SIDE,
    FILL_ITEM_TYPE,
} from "../../../../shared/market-data/fills.ts";
import { ORDER_SIDE } from "../../../../shared/market-data/orders.ts";

/**
 * Reviewed guard-test vector for the authored A104 sale, separate from the
 * oracle's event decoder and all production fill/price/persistence functions.
 * These rows are never inserted into the running system.
 */
export function baselineFillFacts(
    ledger,
    { branch = "A", head = 104, collectionId = 42 } = {},
) {
    const empty = {
        collectionId,
        fillExecutions: [],
        fillItems: [],
        fillAttributions: [],
    };
    const block = ledger.blockAt(branch, 104);
    const fulfillment = block.logs[1];
    if (branch !== "A" || head < 104 || !fulfillment) return empty;
    const transactionHash = block.transactions[0];
    const id = `${ledger.chainId}:${FILL_KIND.Seaport}:${transactionHash}:1`;
    const provenance = {
        chain_id: ledger.chainId,
        kind: FILL_KIND.Seaport,
        tx_hash: transactionHash,
        log_index: 1,
        block_number: 104,
        block_hash: block.hash,
        block_timestamp: block.timestamp,
    };
    return {
        collectionId,
        fillExecutions: [
            {
                id,
                ...provenance,
                protocol_address: ledger.addresses.seaport,
                price_exclusion: null,
                total_price: "1000000000000000000",
                currency: ledger.addresses.weth,
                nft_quantity: "1",
            },
        ],
        fillItems: [
            {
                execution_id: id,
                item_index: 0,
                side: FILL_ITEM_SIDE.Offer,
                item_type: FILL_ITEM_TYPE.Erc721,
                contract_address: ledger.addresses.nft,
                identifier: "1",
                amount: "1",
                recipient: ledger.addresses.buyer,
                unit_offset: "0",
            },
            {
                execution_id: id,
                item_index: 1,
                side: FILL_ITEM_SIDE.Consideration,
                item_type: FILL_ITEM_TYPE.Erc20,
                contract_address: ledger.addresses.weth,
                identifier: "0",
                amount: "1000000000000000000",
                recipient: ledger.addresses.seller,
                unit_offset: "1",
            },
        ],
        fillAttributions: [
            {
                ...provenance,
                collection_id: collectionId,
                execution_id: id,
                item_index: 0,
                order_id: ledger.orders.listing.orderHash,
                order_side: ORDER_SIDE.Sell,
                maker: ledger.addresses.seller,
                taker: ledger.addresses.buyer,
                contract_address: ledger.addresses.nft,
                token_id: "1",
                amount: "1",
            },
        ],
    };
}
