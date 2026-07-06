import {
    BOOTSTRAP_TRIGGER_CLI_FLAG,
    parseBootstrapTriggerArgs,
    printBootstrapTriggerUsage,
    resolveBootstrapTriggerInput,
    triggerBootstrapViaApi,
} from "../src/application/bootstrap-api-trigger.js";

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
