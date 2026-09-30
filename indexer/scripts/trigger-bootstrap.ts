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
    const scope = requestBody.scope;
    const enumerationMode = scope.mode;

    // Summarize the submitted scope without printing a potentially large token list.
    const explicitTokenCount =
        scope.mode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
            ? scope.tokenIds.length
            : null;
    const manualRangeStartTokenId =
        scope.mode === BOOTSTRAP_ENUMERATION_MODE.ManualRange
            ? scope.startTokenId
            : null;
    const manualRangeTotalSupply =
        scope.mode === BOOTSTRAP_ENUMERATION_MODE.ManualRange
            ? scope.tokenCount
            : null;

    for (const warning of result.warnings) console.warn(warning);
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
