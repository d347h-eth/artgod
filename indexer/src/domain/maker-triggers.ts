type ValueOf<T> = T[keyof T];

export const MAKER_TRIGGER_SCOPE = {
    Token: "token",
    Collection: "collection",
    Global: "global",
} as const;

export type MakerTriggerScope = ValueOf<typeof MAKER_TRIGGER_SCOPE>;

export const TOKEN_SCOPED_MAKER_TRIGGER_REASON = {
    NftTransfer: "nft-transfer",
    NftApproval: "nft-approval",
    ItemSold: "item_sold",
    ItemTransferred: "item_transferred",
} as const;

export type TokenScopedMakerTriggerReason = ValueOf<
    typeof TOKEN_SCOPED_MAKER_TRIGGER_REASON
>;

export const COLLECTION_SCOPED_MAKER_TRIGGER_REASON = {
    NftApprovalForAll: "nft-approval-for-all",
} as const;

export type CollectionScopedMakerTriggerReason = ValueOf<
    typeof COLLECTION_SCOPED_MAKER_TRIGGER_REASON
>;

export const GLOBAL_MAKER_TRIGGER_REASON = {
    Erc20Balance: "erc20-balance",
    ApprovalChange: "approval-change",
    OrderCounter: "order-counter",
} as const;

export type GlobalMakerTriggerReason = ValueOf<
    typeof GLOBAL_MAKER_TRIGGER_REASON
>;

export type MakerTriggerReason =
    | TokenScopedMakerTriggerReason
    | CollectionScopedMakerTriggerReason
    | GlobalMakerTriggerReason;
