import { db } from "@artgod/shared/database";
import {
    COLLECTION_CUSTOMIZATION_FEATURE_KEY,
    type CollectionCustomizationFeatureKey,
    type CollectionCustomizationSourceKind,
} from "@artgod/shared/types";

type CustomizationFeatureRow = {
    selected_source: CollectionCustomizationSourceKind;
    user_config_json: string;
};

export class SqliteCollectionCustomizationRecords {
    private selectFeatureStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        featureKey: string;
    }>(
        "SELECT selected_source, user_config_json " +
            "FROM collection_customization_features " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND feature_key = @featureKey " +
            "LIMIT 1",
    );

    private upsertFeatureStmt = db.prepare<{
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

    getFeature(params: {
        chainId: number;
        collectionId: number;
        featureKey: CollectionCustomizationFeatureKey;
    }): {
        selectedSource: CollectionCustomizationSourceKind;
        userConfigJson: string;
    } | null {
        const row = this.selectFeatureStmt.get({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: params.featureKey,
        }) as CustomizationFeatureRow | undefined;
        if (!row) {
            return null;
        }
        return {
            selectedSource: row.selected_source,
            userConfigJson: row.user_config_json,
        };
    }

    upsertFeature(params: {
        chainId: number;
        collectionId: number;
        featureKey: CollectionCustomizationFeatureKey;
        selectedSource: CollectionCustomizationSourceKind;
        userConfigJson: string;
    }): void {
        this.upsertFeatureStmt.run({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: params.featureKey,
            selectedSource: params.selectedSource,
            userConfigJson: params.userConfigJson,
        });
    }

    getTraitFilterPresentationFeature(params: {
        chainId: number;
        collectionId: number;
    }): {
        selectedSource: CollectionCustomizationSourceKind;
        userConfigJson: string;
    } | null {
        return this.getFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey:
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TraitFilterPresentation,
        });
    }

    upsertTraitFilterPresentationFeature(params: {
        chainId: number;
        collectionId: number;
        selectedSource: CollectionCustomizationSourceKind;
        userConfigJson: string;
    }): void {
        this.upsertFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey:
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TraitFilterPresentation,
            selectedSource: params.selectedSource,
            userConfigJson: params.userConfigJson,
        });
    }
}
