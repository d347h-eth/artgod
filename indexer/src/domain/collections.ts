export type CollectionStandard = "erc721" | "erc1155";

export type CollectionStatus =
    | "bootstrapping"
    | "live"
    | "paused"
    | "disabled";

export type CollectionRecord = {
    chainId: number;
    id: string;
    address: string;
    standard: CollectionStandard;
    status: CollectionStatus;
    deploymentBlock: number | null;
    bootstrapAnchorBlock: number | null;
};

export type CollectionUpsertInput = CollectionRecord;
