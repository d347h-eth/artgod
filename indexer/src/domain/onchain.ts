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

export type OnChainData = {
    nftTransferEvents: NftTransferEvent[];
    nftBalanceDeltas: NftBalanceDelta[];
};
