import { describe, expect, it } from "vitest";
import {
    COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG,
    COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT,
    iterateCollectionExtensionArtifactRangePayloads,
    parseCollectionExtensionArtifactRangeTriggerArgs,
    resolveCollectionExtensionArtifactRangeTriggerInput,
} from "../src/application/collection-extension-artifact-range-trigger.js";

const TEST_CHAIN_ID = 1;
const TEST_COLLECTION_ID = 42;
const TEST_CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const TEST_REASON = "operator-repair";
const TEST_SOURCE = "operator-cli";

describe("collection-extension artifact range trigger", () => {
    it("parses and normalizes the standalone artifact job input", () => {
        const args = parseCollectionExtensionArtifactRangeTriggerArgs([
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.ChainId,
            String(TEST_CHAIN_ID),
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.CollectionId,
            String(TEST_COLLECTION_ID),
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Contract,
            `0x${TEST_CONTRACT.slice(2).toUpperCase()}`,
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.FromTokenId,
            "0007",
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.ToTokenId,
            "9",
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Reason,
            TEST_REASON,
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Source,
            TEST_SOURCE,
        ]);

        expect(
            resolveCollectionExtensionArtifactRangeTriggerInput(args, 5),
        ).toEqual({
            chainId: TEST_CHAIN_ID,
            collectionId: TEST_COLLECTION_ID,
            contract: TEST_CONTRACT,
            fromTokenId: 7n,
            toTokenId: 9n,
            reason: TEST_REASON,
            source: TEST_SOURCE,
        });
    });

    it("uses config chain id and application-owned attribution defaults", () => {
        const input = resolveCollectionExtensionArtifactRangeTriggerInput(
            requiredArgs(),
            TEST_CHAIN_ID,
        );

        expect(input.chainId).toBe(TEST_CHAIN_ID);
        expect(input.reason).toBe(
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Reason,
        );
        expect(input.source).toBe(
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Source,
        );
    });

    it("streams payloads matching the current standalone worker schema", () => {
        const input = resolveCollectionExtensionArtifactRangeTriggerInput(
            requiredArgs(),
            TEST_CHAIN_ID,
        );

        expect(
            Array.from(iterateCollectionExtensionArtifactRangePayloads(input)),
        ).toEqual([
            {
                chainId: TEST_CHAIN_ID,
                collectionId: TEST_COLLECTION_ID,
                contract: TEST_CONTRACT,
                tokenId: "7",
                reason: COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Reason,
                source: COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Source,
            },
            {
                chainId: TEST_CHAIN_ID,
                collectionId: TEST_COLLECTION_ID,
                contract: TEST_CONTRACT,
                tokenId: "8",
                reason: COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Reason,
                source: COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Source,
            },
            {
                chainId: TEST_CHAIN_ID,
                collectionId: TEST_COLLECTION_ID,
                contract: TEST_CONTRACT,
                tokenId: "9",
                reason: COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Reason,
                source: COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Source,
            },
        ]);
    });

    it.each([
        [COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.ChainId, "0"],
        [COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.ChainId, "-1"],
        [
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.CollectionId,
            "0",
        ],
        [
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.CollectionId,
            "-1",
        ],
    ])("rejects non-positive identity flag %s=%s", (flag, value) => {
        expect(() =>
            parseCollectionExtensionArtifactRangeTriggerArgs([flag, value]),
        ).toThrow(`${flag} must be a positive integer`);
    });

    it("rejects reversed token ranges before connecting to the queue", () => {
        expect(() =>
            resolveCollectionExtensionArtifactRangeTriggerInput(
                {
                    ...requiredArgs(),
                    fromTokenId: "10",
                    toTokenId: "9",
                },
                TEST_CHAIN_ID,
            ),
        ).toThrow("--from-token-id must be <= --to-token-id");
    });

    it("rejects unknown options instead of silently ignoring them", () => {
        expect(() =>
            parseCollectionExtensionArtifactRangeTriggerArgs(["--unknown"]),
        ).toThrow("Unknown collection-extension artifact range option");
    });
});

function requiredArgs() {
    return {
        collectionId: TEST_COLLECTION_ID,
        contract: TEST_CONTRACT,
        fromTokenId: "7",
        toTokenId: "9",
    };
}
