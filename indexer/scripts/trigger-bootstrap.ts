import {
    BOOTSTRAP_TRIGGER_CLI_FLAG,
    parseBootstrapTriggerArgs,
    printBootstrapTriggerUsage,
    resolveBootstrapTriggerInput,
    triggerBootstrapViaApi,
} from "../src/application/bootstrap-api-trigger.js";
import { BOOTSTRAP_ENUMERATION_MODE } from "@artgod/shared/bootstrap/pipeline";

try {
    const args = parseBootstrapTriggerArgs(process.argv.slice(2));
    if (args.help) {
        printBootstrapTriggerUsage();
        process.exit(0);
    }
    if (!args.address) {
        printBootstrapTriggerUsage();
        process.exit(1);
    }

    const input = resolveBootstrapTriggerInput(args);
    const result = await triggerBootstrapViaApi(input);
    const requestBody = result.requestBody;
    const manualInput = requestBody.manualInput;
    const enumerationMode = requestBody.supportsEnumerable
        ? BOOTSTRAP_ENUMERATION_MODE.Enumerable
        : manualInput?.mode;

    // Summarize the submitted scope without printing a potentially large token list.
    const explicitTokenCount =
        manualInput?.mode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
            ? manualInput.tokenIds.length
            : null;
    const manualRangeStartTokenId =
        manualInput?.mode === BOOTSTRAP_ENUMERATION_MODE.ManualRange
            ? manualInput.startTokenId
            : null;
    const manualRangeTotalSupply =
        manualInput?.mode === BOOTSTRAP_ENUMERATION_MODE.ManualRange
            ? manualInput.totalSupply
            : null;

    console.log(
        [
            "Queued bootstrap run:",
            `backendOrigin=${input.backendOrigin}`,
            `chainRef=${input.chainRef}`,
            `chainId=${input.chainId}`,
            `collectionId=${result.collectionId}`,
            `runId=${result.runId}`,
            `status=${result.status}`,
            `address=${input.address}`,
            `slug=${input.slug}`,
            `openseaSlug=${input.openseaSlug ?? "none"}`,
            `metadataMode=${input.metadataMode}`,
            `supportsEnumerable=${String(requestBody.supportsEnumerable)}`,
            `sampleTokenId=${input.sampleTokenId ?? "auto"}`,
            `enumerationMode=${enumerationMode ?? "none"}`,
            `explicitTokenCount=${explicitTokenCount ?? "none"}`,
            `manualRangeStartTokenId=${manualRangeStartTokenId ?? "none"}`,
            `manualRangeTotalSupply=${manualRangeTotalSupply ?? "none"}`,
            `imageSourceField=${requestBody.imageSourceField}`,
            `animationSourceField=${requestBody.animationSourceField ?? "none"}`,
            `imageCacheSource=${requestBody.imageCache.selectedSource}`,
            `imageCacheMode=${requestBody.imageCache.imageCacheMode}`,
            `deploymentBlock=${input.deploymentBlock ?? "none"}`,
        ].join(" "),
    );
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Bootstrap trigger failed: ${message}`);
    console.error(
        `Run with ${BOOTSTRAP_TRIGGER_CLI_FLAG.Help} to show supported options.`,
    );
    process.exit(1);
}
