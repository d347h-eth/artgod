import type { Hex, RpcLog } from "../ports/rpc.js";
import type {
    GlobalMakerTriggerReason,
    TokenScopedMakerTriggerReason,
} from "./maker-triggers.js";

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

// Token-scoped maker trigger = ownership changed for a specific collection token.
export type TokenScopedMakerTrigger = CollectionScopedTokenAttribution & {
    maker: string;
    reason: TokenScopedMakerTriggerReason;
};

// Global maker trigger = maker-wide fillability changed, but no single collection
// can be identified at sync time yet.
export type GlobalMakerTrigger = ChainAttribution & {
    maker: string;
    reason: GlobalMakerTriggerReason;
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

export type CollectionScopedOnChainData = {
    nftTransferEvents: NftTransferEvent[];
    nftBalanceDeltas: NftBalanceDelta[];
    fillEvents: FillEvent[];
    orderInfos: OrderInfo[];
    makerTriggers: TokenScopedMakerTrigger[];
    metadataRefreshEvents: MetadataRefreshEvent[];
    metadataRefreshRangeEvents: MetadataRefreshRangeEvent[];
};

export type GlobalOnChainTriggers = {
    cancelEvents: CancelEvent[];
    makerTriggers: GlobalMakerTrigger[];
};

// Sync output is split by scope on purpose:
// - collectionScoped: work that is already resolved to one collection
// - global: broader triggers that still need downstream lookup/orchestration
export type OnChainData = {
    transactions: TransactionRecord[];
    collectionScoped: CollectionScopedOnChainData;
    global: GlobalOnChainTriggers;
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
