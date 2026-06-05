import type { Hex, RpcLog } from "../ports/rpc.js";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import {
    COLLECTION_STANDARD,
    type CollectionStandard,
} from "./collections.js";
import type {
    CollectionScopedMakerTriggerReason,
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

// NFT approval scope tells downstream workers how broadly to revalidate maker state.
export const NFT_APPROVAL_SCOPE = {
    Token: "token",
    Collection: "collection",
} as const;

export type NftApprovalScope =
    (typeof NFT_APPROVAL_SCOPE)[keyof typeof NFT_APPROVAL_SCOPE];

// Collection-scoped token transfer captured from on-chain logs.
export type NftTransferEvent = CollectionScopedTokenAttribution & {
    from: string;
    to: string;
    amount: string;
    kind: CollectionStandard;
};

type TokenScopedNftApprovalEvent = CollectionScopedTokenAttribution & {
    scope: typeof NFT_APPROVAL_SCOPE.Token;
    owner: string;
    operator: string;
    kind: typeof COLLECTION_STANDARD.Erc721;
};

type CollectionScopedNftApprovalEvent = CollectionScopedChainAttribution & {
    scope: typeof NFT_APPROVAL_SCOPE.Collection;
    contract: string;
    owner: string;
    operator: string;
    approved: boolean;
    kind: CollectionStandard;
};

// NFT approval events are ephemeral maker-state hints, not persisted inventory.
export type NftApprovalEvent =
    | TokenScopedNftApprovalEvent
    | CollectionScopedNftApprovalEvent;

// Narrows approval events without leaking raw scope literals to callers.
export function isTokenScopedNftApprovalEvent(
    event: NftApprovalEvent,
): event is Extract<
    NftApprovalEvent,
    { scope: typeof NFT_APPROVAL_SCOPE.Token }
> {
    return event.scope === NFT_APPROVAL_SCOPE.Token;
}

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

// Collection-scoped maker trigger = collection-wide NFT approval changed.
export type CollectionScopedMakerTrigger = CollectionScopedChainAttribution & {
    contract: string;
    maker: string;
    reason: CollectionScopedMakerTriggerReason;
};

export type CollectionMakerTrigger =
    | TokenScopedMakerTrigger
    | CollectionScopedMakerTrigger;

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

// Collection extension facts are immutable domain events emitted by installed extensions.
export type CollectionExtensionEvent = CollectionScopedChainAttribution & {
    contract: string;
    tokenId?: string | null;
    extensionKey: CollectionExtensionKey;
    eventKey: string;
    maker?: string | null;
    contentHash?: string | null;
    payload?: Record<string, unknown> | null;
};

// Extension event media is an immutable, event-scoped preview artifact.
export type CollectionExtensionEventMedia = CollectionScopedTokenAttribution & {
    extensionKey: CollectionExtensionKey;
    eventKey: string;
    mediaRef: string;
    image?: string | null;
    animationUrl?: string | null;
    htmlContent?: string | null;
    renderModes?: { key: string; label: string }[];
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
    nftApprovalEvents: NftApprovalEvent[];
    nftBalanceDeltas: NftBalanceDelta[];
    fillEvents: FillEvent[];
    orderInfos: OrderInfo[];
    makerTriggers: CollectionMakerTrigger[];
    metadataRefreshEvents: MetadataRefreshEvent[];
    metadataRefreshRangeEvents: MetadataRefreshRangeEvent[];
    collectionExtensionEvents: CollectionExtensionEvent[];
    collectionExtensionEventMedia: CollectionExtensionEventMedia[];
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
    standard: CollectionStandard;
    from: string;
    to: string;
    tokenId: string;
    amount: string;
};

export type EnhancedEvent = {
    kind: CollectionStandard;
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
