import type { Hex, RpcLog } from "../ports/rpc.js";

export type ChainAttribution = {
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
};

type CollectionScopedChainAttribution = ChainAttribution & {
    collectionId: number;
};

type CollectionScopedTokenAttribution = CollectionScopedChainAttribution & {
    contract: string;
    tokenId: string;
};

// Collection-scoped token transfer captured from on-chain logs.
export type NftTransferEvent = CollectionScopedTokenAttribution & {
    from: string;
    to: string;
    amount: string;
    kind: "erc721" | "erc1155";
};

export type NftBalanceDelta = CollectionScopedTokenAttribution & {
    owner: string;
    delta: string;
};

// Fill = an on-chain execution of an order (Seaport/Blur/on-chain orderbooks).
export type FillEvent = CollectionScopedTokenAttribution & {
    orderId?: string;
    kind?: string;
    orderSide?: "sell" | "buy";
    maker?: string;
    taker?: string;
    amount?: string;
    price?: string;
    currency?: string;
};

// Cancel = explicit on-chain invalidation of an order (e.g. Seaport cancel/counter).
export type CancelEvent = ChainAttribution & {
    orderId?: string;
    kind?: string;
    maker?: string;
};

// Order = on-chain creation/listing for orderbooks that emit orders on-chain.
export type OrderInfo = CollectionScopedTokenAttribution & {
    orderId?: string;
    kind?: string;
    maker?: string;
    price?: string;
    currency?: string;
};

// Maker trigger = maker's fillability changed (balance/approval/ownership/counter).
export type MakerInfo = ChainAttribution & {
    maker: string;
    contract?: string;
    tokenId?: string;
    reason:
        | "nft-transfer"
        | "erc20-balance"
        | "approval-change"
        | "order-counter";
};

// Metadata refresh trigger derived from on-chain events (e.g. ERC-4906).
export type MetadataRefreshEvent = CollectionScopedTokenAttribution & {
    reason: string;
    trigger: string;
};

export type MetadataRefreshRangeEvent = CollectionScopedChainAttribution & {
    contract: string;
    fromTokenId: string;
    toTokenId: string;
    reason: string;
    trigger: string;
};

export type TransactionRecord = {
    hash: string;
    from: string;
    to: string | null;
    input: string;
    blockNumber: number;
    blockHash: string;
};

// OnChainData intentionally mixes collection-scoped token events with broader
// global triggers. Transfers/fills/orders/metadata refreshes are resolved to a
// concrete collection up front; cancels and some maker triggers remain global
// until downstream processing because they do not identify one collection yet.
export type OnChainData = {
    nftTransferEvents: NftTransferEvent[];
    nftBalanceDeltas: NftBalanceDelta[];
    transactions: TransactionRecord[];
    fillEvents: FillEvent[];
    cancelEvents: CancelEvent[];
    orderInfos: OrderInfo[];
    makerInfos: MakerInfo[];
    metadataRefreshEvents: MetadataRefreshEvent[];
    metadataRefreshRangeEvents: MetadataRefreshRangeEvent[];
};

export type EventBase = {
    contract: string;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
    batchIndex?: number;
};

export type TransferDecoded = {
    standard: "erc721" | "erc1155";
    from: string;
    to: string;
    tokenId: string;
    amount: string;
};

export type EnhancedEvent = {
    kind: "erc721" | "erc1155";
    base: EventBase;
    decoded: TransferDecoded;
};

export type TransactionSummary = {
    hash: string;
    from: string;
    to: string | null;
    input: Hex;
};

export type EnhancedTransaction = {
    txHash: string;
    transaction: TransactionSummary;
    events: EnhancedEvent[];
    receiptLogs: RpcLog[];
    blockNumber: number;
    blockHash: string;
};
