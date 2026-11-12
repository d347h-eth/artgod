import {
    getDefaultDebugPayloadPersistenceConfig,
    type DebugPayloadPersistenceConfig,
} from "@artgod/shared/config/debug-payload-persistence";
import { MetadataDomain } from "../application/metadata/domain.js";
import { CollectionExtensionMetadataReadiness } from "../application/collection-extensions/metadata-readiness.js";
import { SqliteCollectionExtensions } from "../infra/collection-extensions/sqlite.js";
import { SqliteMetadataStore } from "../infra/metadata/sqlite-metadata-store.js";
import type {
    MetadataFetcherPort,
    TokenUriResolverPort,
} from "../ports/metadata.js";

/** Shared composition for bootstrap and domain runtimes; every entry path retains the same obligation. */
export function createMetadataDomain(
    resolver: TokenUriResolverPort,
    fetcher: MetadataFetcherPort,
    debugPayloads: DebugPayloadPersistenceConfig = getDefaultDebugPayloadPersistenceConfig(),
): MetadataDomain {
    return new MetadataDomain({
        resolver,
        fetcher,
        store: new SqliteMetadataStore(debugPayloads),
        readiness: new CollectionExtensionMetadataReadiness(
            new SqliteCollectionExtensions(debugPayloads),
        ),
    });
}
