import type {
    MetadataReadinessPort,
    MetadataTarget,
} from "../../domain/metadata-pending.js";
import type { TokenMetadata } from "../../domain/metadata.js";
import type { CollectionExtensionInstallPort } from "../../ports/collection-extensions.js";
import { resolveIndexerCollectionExtension } from "./index.js";

/** Collections opt into content readiness; ordinary successful metadata remains ready by default. */
export class CollectionExtensionMetadataReadiness implements MetadataReadinessPort {
    constructor(
        private readonly installs: Pick<
            CollectionExtensionInstallPort,
            "getInstall"
        >,
    ) {}
    isReady(target: MetadataTarget, metadata: TokenMetadata): boolean {
        const install = this.installs.getInstall(
            target.chainId,
            target.collectionId,
        );
        if (!install?.enabled) return true;
        return (
            resolveIndexerCollectionExtension(install)?.isMetadataReady?.(
                metadata,
            ) ?? true
        );
    }
}
