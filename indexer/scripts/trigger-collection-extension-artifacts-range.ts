import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config/index.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { publishCollectionExtensionRefreshArtifacts } from "../src/application/collection-extensions/jobs.js";
import {
    COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG,
    iterateCollectionExtensionArtifactRangePayloads,
    parseCollectionExtensionArtifactRangeTriggerArgs,
    printCollectionExtensionArtifactRangeTriggerUsage,
    resolveCollectionExtensionArtifactRangeTriggerInput,
} from "../src/application/collection-extension-artifact-range-trigger.js";
import { COLLECTION_EXTENSION_JOB_KIND } from "../src/domain/collection-extension-jobs.js";

try {
    const args = parseCollectionExtensionArtifactRangeTriggerArgs(
        process.argv.slice(2),
    );
    if (args.help) {
        printCollectionExtensionArtifactRangeTriggerUsage();
        process.exit(0);
    }

    const config = loadConfig();
    const input = resolveCollectionExtensionArtifactRangeTriggerInput(
        args,
        config.chainId,
    );
    const queue = await NatsJetStreamQueue.connect({
        natsUrl: config.queue.natsUrl,
        streamPrefix: config.queue.streamPrefix,
    });

    let published = 0;
    try {
        // Publish each standalone job through the canonical artifact job builder.
        for (const payload of iterateCollectionExtensionArtifactRangePayloads(
            input,
        )) {
            await publishCollectionExtensionRefreshArtifacts(
                queue,
                payload,
                randomUUID(),
            );
            published += 1;
        }
    } finally {
        await queue.close();
    }

    console.log(
        `Queued ${published} ${COLLECTION_EXTENSION_JOB_KIND.RefreshArtifacts} jobs for collectionId=${input.collectionId} contract=${input.contract} tokenRange=${input.fromTokenId.toString()}-${input.toTokenId.toString()} reason=${input.reason}`,
    );
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
        `Collection-extension artifact range trigger failed: ${message}`,
    );
    console.error(
        `Run with ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Help} to show supported options.`,
    );
    process.exit(1);
}
