import { db } from "@artgod/shared/database";
import {
    COLLECTION_CUSTOMIZATION_FEATURE_KEY,
    type CollectionCustomizationSourceKind,
} from "@artgod/shared/types";

type CustomizationFeatureRow = {
    selected_source: CollectionCustomizationSourceKind;
    user_config_json: string;
};

export class SqliteCollectionCustomizationRecords {
    private selectTraitFilterPresentationFeature = db.prepare<{
        chainId: number;
        collectionId: number;
        featureKey: string;
    }>(
        "SELECT selected_source, user_config_json " +
            "FROM collection_customization_features " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND feature_key = @featureKey " +
            "LIMIT 1",
    );

    private upsertTraitFilterPresentationFeatureStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        featureKey: string;
        selectedSource: CollectionCustomizationSourceKind;
        userConfigJson: string;
    }>(
        "INSERT INTO collection_customization_features " +
            "(chain_id, collection_id, feature_key, selected_source, user_config_json) " +
            "VALUES (@chainId, @collectionId, @featureKey, @selectedSource, @userConfigJson) " +
            "ON CONFLICT(chain_id, collection_id, feature_key) DO UPDATE SET " +
            "selected_source = excluded.selected_source, " +
            "user_config_json = excluded.user_config_json, " +
            "updated_at = CURRENT_TIMESTAMP",
    );

    getTraitFilterPresentationFeature(params: {
        chainId: number;
        collectionId: number;
    }): {
        selectedSource: CollectionCustomizationSourceKind;
        userConfigJson: string;
    } | null {
        const row = this.selectTraitFilterPresentationFeature.get({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey:
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TraitFilterPresentation,
        }) as CustomizationFeatureRow | undefined;
        if (!row) {
            return null;
        }
        return {
            selectedSource: row.selected_source,
            userConfigJson: row.user_config_json,
        };
    }

    upsertTraitFilterPresentationFeature(params: {
        chainId: number;
        collectionId: number;
        selectedSource: CollectionCustomizationSourceKind;
        userConfigJson: string;
    }): void {
        this.upsertTraitFilterPresentationFeatureStmt.run({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey:
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TraitFilterPresentation,
            selectedSource: params.selectedSource,
            userConfigJson: params.userConfigJson,
        });
    }
}
