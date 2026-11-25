/** Canonical order vocabulary shared by ingestion and market read models. */
export const ORDER_STATUS = {
    Fillable: "fillable",
    Filled: "filled",
    Cancelled: "cancelled",
    Expired: "expired",
    NoBalance: "no-balance",
    NoApproval: "no-approval",
    Invalid: "invalid",
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export const ORDER_SOURCE_STATUS = {
    Active: "active",
    Inactive: "inactive",
    Cancelled: "cancelled",
    Filled: "filled",
    Invalidated: "invalidated",
    Expired: "expired",
    Unknown: "unknown",
} as const;
export type OrderSourceStatus =
    (typeof ORDER_SOURCE_STATUS)[keyof typeof ORDER_SOURCE_STATUS];

export const ORDER_SOURCE_SCOPE_KIND = {
    Token: "token",
    Collection: "collection",
    Attribute: "attribute",
    TokenSet: "token_set",
} as const;
export type OrderSourceScopeKind =
    (typeof ORDER_SOURCE_SCOPE_KIND)[keyof typeof ORDER_SOURCE_SCOPE_KIND];

export const ORDER_SIDE = { Buy: "buy", Sell: "sell" } as const;
export type OrderSide = (typeof ORDER_SIDE)[keyof typeof ORDER_SIDE];

export const ORDERBOOK_VENUE = { OpenSea: "opensea", Vvv: "vvv" } as const;
export type OrderbookVenue =
    (typeof ORDERBOOK_VENUE)[keyof typeof ORDERBOOK_VENUE];

export const SEAPORT_MAINNET_V1_6 =
    "0x0000000000000068F116a894984e2DB1123eB395";
