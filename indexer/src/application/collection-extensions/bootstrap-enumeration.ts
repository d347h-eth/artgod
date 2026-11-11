import { BOOTSTRAP_ENUMERATION_MODE } from "@artgod/shared/bootstrap/pipeline";
import type { BootstrapRunDefinition } from "../../ports/bootstrap-runs.js";
import type { CollectionExtensionInstallPort } from "../../ports/collection-extensions.js";
import type { BootstrapExtensionEnumerator } from "../bootstrap-token-enumeration.js";
import { resolveIndexerCollectionExtension } from "./index.js";
import type { CollectionExtensionBootstrapEnumerationContext } from "./types.js";

/** Bind only an enabled install selected by admission for this exact run. */
export function bindCollectionExtensionBootstrapEnumerator(input: {
    run: Pick<
        BootstrapRunDefinition,
        "chainId" | "collectionId" | "requestExtensionKey" | "enumerationMode"
    >;
    installs: Pick<CollectionExtensionInstallPort, "getInstall">;
    rpc: CollectionExtensionBootstrapEnumerationContext["rpc"];
}): BootstrapExtensionEnumerator | undefined {
    const { run } = input;
    if (
        run.enumerationMode !== BOOTSTRAP_ENUMERATION_MODE.Enumerable ||
        !run.requestExtensionKey
    )
        return undefined;
    const install = input.installs.getInstall(run.chainId, run.collectionId);
    if (
        !install?.enabled ||
        install.chainId !== run.chainId ||
        install.collectionId !== run.collectionId ||
        install.extensionKey !== run.requestExtensionKey
    )
        throw new Error(
            "Requested bootstrap extension install is missing, disabled or mismatched",
        );
    const extension = resolveIndexerCollectionExtension(install);
    if (!extension)
        throw new Error(
            `Requested bootstrap extension implementation missing: ${run.requestExtensionKey}`,
        );
    const enumerate = extension.enumerateBootstrapTokenIds;
    return enumerate
        ? (context) =>
              enumerate.call(extension, { ...context, rpc: input.rpc, install })
        : undefined;
}
