// Generic per-collection setting row used by domain-specific settings adapters.
export type PersistedCollectionSettingRecord = {
    chainId: number;
    collectionId: number;
    key: string;
    valueJson: string;
    createdAt: string;
    updatedAt: string;
};
