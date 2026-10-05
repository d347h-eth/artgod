import { db } from "../database/db.js";
import {
    FILL_KIND,
    FILL_ITEM_SIDE,
    FILL_ITEM_TYPE,
    fillExecutionIdentity,
    prepareFillExecution,
    type FillExecutionItem,
} from "../market-data/fills.js";

/** Explicit fresh-schema boundary fixtures for reader/projector tests. These
 * seed authoritative facts, never inferred historical single-token counts. */
export function insertFillFixture(input: {
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    blockTimestamp: number;
    blockHash?: string;
    kind?: string;
    orderId?: string | null;
    orderSide?: string | null;
    maker?: string | null;
    taker?: string | null;
    amount?: string;
    totalPrice?: string;
    currency?: string;
    items?: readonly FillExecutionItem[];
    itemIndex?: number;
}): string {
    const kind = input.kind ?? FILL_KIND.Seaport;
    const id = fillExecutionIdentity(
        input.chainId,
        kind,
        input.txHash,
        input.logIndex,
    );
    const items = input.items ?? [
        {
            index: 0,
            side: FILL_ITEM_SIDE.Offer,
            itemType:
                BigInt(input.amount ?? "1") > 1n
                    ? FILL_ITEM_TYPE.Erc1155
                    : FILL_ITEM_TYPE.Erc721,
            contract: input.contract,
            identifier: input.tokenId,
            amount: input.amount ?? "1",
            recipient: null,
        },
        {
            index: 1,
            side: FILL_ITEM_SIDE.Consideration,
            itemType:
                !input.currency ||
                input.currency === "0x0000000000000000000000000000000000000000"
                    ? FILL_ITEM_TYPE.Native
                    : FILL_ITEM_TYPE.Erc20,
            contract:
                input.currency ?? "0x0000000000000000000000000000000000000000",
            identifier: "0",
            amount: input.totalPrice ?? "1",
            recipient: null,
        },
    ];
    const { payment, items: preparedItems } = prepareFillExecution({
        protocolAddress: input.contract,
        items,
    });
    db.prepare(
        `INSERT OR IGNORE INTO fill_executions (id,chain_id,kind,protocol_address,tx_hash,log_index,block_number,block_hash,block_timestamp,price_exclusion,total_price,currency,nft_quantity)
        VALUES(@id,@chainId,@kind,@contract,@txHash,@logIndex,@blockNumber,@blockHash,@blockTimestamp,@exclusion,@totalPrice,@currency,@nftQuantity)`,
    ).run({
        ...input,
        id,
        kind,
        blockHash: input.blockHash ?? "hash",
        ...payment,
    });
    for (const item of preparedItems) {
        db.prepare(
            `INSERT OR IGNORE INTO fill_execution_items (execution_id,item_index,side,item_type,contract_address,identifier,amount,recipient,unit_offset)
            VALUES(@id,@index,@side,@itemType,@contract,@identifier,@amount,@recipient,@unitOffset)`,
        ).run({ id, ...item });
    }
    const item = items[input.itemIndex ?? 0]!;
    db.prepare(
        `INSERT INTO fills (chain_id,collection_id,execution_id,item_index,kind,order_id,order_side,maker,taker,contract_address,token_id,amount,block_number,block_hash,block_timestamp,tx_hash,log_index)
        VALUES(@chainId,@collectionId,@id,@itemIndex,@kind,@orderId,@orderSide,@maker,@taker,@contract,@tokenId,@amount,@blockNumber,@blockHash,@blockTimestamp,@txHash,@logIndex)`,
    ).run({
        ...input,
        id,
        kind,
        itemIndex: item.index,
        orderId: input.orderId ?? null,
        orderSide: input.orderSide ?? null,
        maker: input.maker ?? null,
        taker: input.taker ?? null,
        amount: item.amount,
        blockHash: input.blockHash ?? "hash",
    });
    return id;
}
