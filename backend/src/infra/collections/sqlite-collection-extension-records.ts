import { db } from "@artgod/shared/database";
import type {
    CollectionExtensionInstall,
    CollectionExtensionKey,
} from "@artgod/shared/extensions";
import { normalizeAddressRef } from "@artgod/shared/utils/ref-resolver";
import type { BackendCollectionExtensionArtifactRecord } from "../../application/collection-extensions/types.js";

type InstallRow = {
    chain_id: number;
    collection_id: number;
    extension_key: CollectionExtensionKey;
    enabled: number;
    config_json: string;
    created_at: string;
    updated_at: string;
};

type ArtifactRow = {
    extension_key: CollectionExtensionKey;
    artifact_ref: string;
    image: string | null;
    animation_url: string | null;
    html_content: string | null;
};

export class SqliteCollectionExtensionRecords {
    private selectInstallByContract = db.prepare<{
        chainId: number;
        contractAddress: string;
    }>(
        "SELECT cei.chain_id, cei.collection_id, cei.extension_key, cei.enabled, cei.config_json, cei.created_at, cei.updated_at " +
            "FROM collection_extension_installs cei " +
            "JOIN collections c ON c.collection_id = cei.collection_id " +
            "WHERE cei.chain_id = @chainId AND lower(c.address) = @contractAddress " +
            "LIMIT 1",
    );

    private selectArtifact = db.prepare<{
        chainId: number;
        contractAddress: string;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        artifactRef: string;
    }>(
        "SELECT extension_key, artifact_ref, image, animation_url, html_content " +
            "FROM token_extension_artifacts " +
            "WHERE chain_id = @chainId AND contract_address = @contractAddress AND token_id = @tokenId " +
            "AND extension_key = @extensionKey AND artifact_ref = @artifactRef " +
            "LIMIT 1",
    );

    getInstallByContract(
        chainId: number,
        contractAddress: string,
    ): CollectionExtensionInstall | null {
        const row = this.selectInstallByContract.get({
            chainId,
            contractAddress: normalizeAddressRef(contractAddress),
        }) as InstallRow | undefined;
        if (!row) {
            return null;
        }

        return {
            chainId: row.chain_id,
            collectionId: row.collection_id,
            extensionKey: row.extension_key,
            enabled: row.enabled === 1,
            configJson: row.config_json,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    getArtifact(params: {
        chainId: number;
        contractAddress: string;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        artifactRef: string;
    }): BackendCollectionExtensionArtifactRecord | null {
        const row = this.selectArtifact.get({
            chainId: params.chainId,
            contractAddress: normalizeAddressRef(params.contractAddress),
            tokenId: params.tokenId,
            extensionKey: params.extensionKey,
            artifactRef: params.artifactRef,
        }) as ArtifactRow | undefined;
        if (!row) {
            return null;
        }

        return {
            extensionKey: row.extension_key,
            artifactRef: row.artifact_ref,
            image: row.image,
            animationUrl: row.animation_url,
            htmlContent: row.html_content,
        };
    }
}
