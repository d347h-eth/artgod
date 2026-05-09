import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import { resolveEmbeddedCollectionExtensionInstall } from "@artgod/shared/extensions/built-ins";
import type {
    EmbeddedCollectionExtensionResolveInput,
    EmbeddedCollectionExtensionResolverPort,
} from "../../application/use-cases/bootstrap/create-bootstrap-run.js";

export class BuiltInCollectionExtensionResolver
    implements EmbeddedCollectionExtensionResolverPort
{
    resolveExtensionKey(
        input: EmbeddedCollectionExtensionResolveInput,
    ): CollectionExtensionKey | null {
        const install = resolveEmbeddedCollectionExtensionInstall(input);
        return install?.extensionKey ?? null;
    }
}
