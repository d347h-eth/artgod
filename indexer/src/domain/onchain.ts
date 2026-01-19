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
