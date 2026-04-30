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

export const ORDER_LOCAL_TOKEN_SET_STATUS = {
    None: "none",
    Resolved: "resolved",
    Unresolved: "unresolved",
    Mismatch: "mismatch",
} as const;

export type OrderLocalTokenSetStatus =
    (typeof ORDER_LOCAL_TOKEN_SET_STATUS)[keyof typeof ORDER_LOCAL_TOKEN_SET_STATUS];

export const ORDER_SEAPORT_DATA_SOURCE_KIND = {
    Stream: "stream",
    Rest: "rest",
} as const;

export type OrderSeaportDataSourceKind =
    (typeof ORDER_SEAPORT_DATA_SOURCE_KIND)[keyof typeof ORDER_SEAPORT_DATA_SOURCE_KIND];

export type SeaportOrderItem = {
    itemType: string;
    token: string;
    identifierOrCriteria: string;
    startAmount: string;
    endAmount: string;
};

export type SeaportConsiderationItem = SeaportOrderItem & {
    recipient: string;
};

export type SeaportOrderData = {
    protocolAddress: string;
    signature: string | null;
    offerer: string;
    zone: string;
    offer: SeaportOrderItem[];
    consideration: SeaportConsiderationItem[];
    orderType: string;
    startTime: string;
    endTime: string;
    zoneHash: string;
    salt: string;
    conduitKey: string;
    totalOriginalConsiderationItems: string;
    counter: string;
};

export type OrderRecord = {
    id: string;
    chainId: number;
    collectionId: number;
    kind: string;
    side?: "buy" | "sell" | null;
    source?: string | null;
    maker: string;
    taker?: string | null;
    contract: string;
    tokenId?: string | null;
    sourceScopeKind?: OrderSourceScopeKind | null;
    sourceCriteriaRoot?: string | null;
    sourceEncodedTokenIds?: string | null;
    sourceSchemaJson?: string | null;
    localTokenSetStatus?: OrderLocalTokenSetStatus | null;
    tokenSetId?: string | null;
    tokenSetSchemaHash?: string | null;
    quantity?: string | null;
    price?: string | null;
    currency?: string | null;
    validFrom?: number | null;
    validUntil?: number | null;
    fillabilityStatus: OrderStatus;
    sourceStatus: OrderSourceStatus;
    seaportData?: SeaportOrderData | null;
    seaportDataSourceKind?: OrderSeaportDataSourceKind | null;
    blockNumber?: number | null;
    txHash?: string | null;
    logIndex?: number | null;
};
