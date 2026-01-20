export type NftTransferEvent = {
    contract: string;
    from: string;
    to: string;
    tokenId: string;
    amount: string;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
    kind: "erc721" | "erc1155";
};

export type NftBalanceDelta = {
    contract: string;
    tokenId: string;
    owner: string;
    delta: string;
    blockNumber: number;
    txHash: string;
    logIndex: number;
};

export type ChainAttribution = {
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
};

// Fill = an on-chain execution of an order (Seaport/Blur/on-chain orderbooks).
export type FillEvent = ChainAttribution & {
    orderId?: string;
    kind?: string;
    maker?: string;
    taker?: string;
    contract?: string;
    tokenId?: string;
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
export type OrderInfo = ChainAttribution & {
    orderId?: string;
    kind?: string;
    maker?: string;
    contract?: string;
    tokenId?: string;
    price?: string;
    currency?: string;
};

// Maker trigger = maker's fillability changed (balance/approval/ownership).
export type MakerInfo = ChainAttribution & {
    maker: string;
    contract?: string;
    tokenId?: string;
    reason: "nft-transfer" | "erc20-balance" | "approval-change";
};

export type TransactionRecord = {
    hash: string;
    from: string;
    to: string | null;
    input: string;
    blockNumber: number;
    blockHash: string;
};

export type OnChainData = {
    nftTransferEvents: NftTransferEvent[];
    nftBalanceDeltas: NftBalanceDelta[];
    transactions: TransactionRecord[];
    fillEvents: FillEvent[];
    cancelEvents: CancelEvent[];
    orderInfos: OrderInfo[];
    makerInfos: MakerInfo[];
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
    input: string;
};

export type EnhancedTransaction = {
    txHash: string;
    transaction: TransactionSummary;
    events: EnhancedEvent[];
    blockNumber: number;
    blockHash: string;
};
