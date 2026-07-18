import {
    isAddressRef,
    normalizeAddressRef,
} from "@artgod/shared/utils/ref-resolver";
import type { CollectionExtensionRefreshArtifactsPayload } from "../domain/collection-extension-jobs.js";

// CLI flags form the operator-facing contract for the artifact range helper.
export const COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG = {
    Help: "--help",
    ChainId: "--chain-id",
    CollectionId: "--collection-id",
    Contract: "--contract",
    FromTokenId: "--from-token-id",
    ToTokenId: "--to-token-id",
    Reason: "--reason",
    Source: "--source",
} as const;

// Standalone manual jobs use these defaults when no attribution is supplied.
export const COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT = {
    Reason: "manual-refresh",
    Source: "manual",
} as const;

// Parsed CLI arguments stay optional until config-backed input resolution.
export type CollectionExtensionArtifactRangeTriggerCliArgs = {
    help?: boolean;
    chainId?: number;
    collectionId?: number;
    contract?: string;
    fromTokenId?: string;
    toTokenId?: string;
    reason?: string;
    source?: string;
};

// Resolved range input is normalized before any queue connection is opened.
export type CollectionExtensionArtifactRangeTriggerInput = {
    chainId: number;
    collectionId: number;
    contract: string;
    fromTokenId: bigint;
    toTokenId: bigint;
    reason: string;
    source: string;
};

// Parses the range helper CLI without loading config or connecting to NATS.
export function parseCollectionExtensionArtifactRangeTriggerArgs(
    raw: string[],
): CollectionExtensionArtifactRangeTriggerCliArgs {
    const parsed: CollectionExtensionArtifactRangeTriggerCliArgs = {};
    for (let index = 0; index < raw.length; index += 1) {
        const arg = raw[index];
        if (!arg) continue;
        switch (arg) {
            case COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Help:
                parsed.help = true;
                break;
            case COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.ChainId:
                parsed.chainId = parsePositiveIntegerFlag(
                    requireFlagValue(raw, index, arg),
                    arg,
                );
                index += 1;
                break;
            case COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.CollectionId:
                parsed.collectionId = parsePositiveIntegerFlag(
                    requireFlagValue(raw, index, arg),
                    arg,
                );
                index += 1;
                break;
            case COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Contract:
                parsed.contract = requireFlagValue(raw, index, arg);
                index += 1;
                break;
            case COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.FromTokenId:
                parsed.fromTokenId = requireFlagValue(raw, index, arg);
                index += 1;
                break;
            case COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.ToTokenId:
                parsed.toTokenId = requireFlagValue(raw, index, arg);
                index += 1;
                break;
            case COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Reason:
                parsed.reason = requireFlagValue(raw, index, arg);
                index += 1;
                break;
            case COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Source:
                parsed.source = requireFlagValue(raw, index, arg);
                index += 1;
                break;
            default:
                throw new Error(
                    `Unknown collection-extension artifact range option: ${arg}`,
                );
        }
    }
    return parsed;
}

// Resolves CLI values into the current standalone artifact job payload domain.
export function resolveCollectionExtensionArtifactRangeTriggerInput(
    args: CollectionExtensionArtifactRangeTriggerCliArgs,
    defaultChainId: number,
): CollectionExtensionArtifactRangeTriggerInput {
    const chainId = parsePositiveInteger(
        args.chainId ?? defaultChainId,
        "chainId",
    );
    const collectionId = parseRequiredPositiveInteger(
        args.collectionId,
        COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.CollectionId,
    );
    const contract = normalizeContract(args.contract);
    const fromTokenId = normalizeTokenId(
        args.fromTokenId,
        COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.FromTokenId,
    );
    const toTokenId = normalizeTokenId(
        args.toTokenId,
        COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.ToTokenId,
    );
    if (fromTokenId > toTokenId) {
        throw new Error(
            `${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.FromTokenId} must be <= ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.ToTokenId}`,
        );
    }

    return {
        chainId,
        collectionId,
        contract,
        fromTokenId,
        toTokenId,
        reason: normalizeAttribution(
            args.reason,
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Reason,
        ),
        source: normalizeAttribution(
            args.source,
            COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Source,
        ),
    };
}

// Streams payloads so large operator-selected ranges are not allocated in memory.
export function* iterateCollectionExtensionArtifactRangePayloads(
    input: CollectionExtensionArtifactRangeTriggerInput,
): Generator<CollectionExtensionRefreshArtifactsPayload> {
    for (
        let tokenId = input.fromTokenId;
        tokenId <= input.toTokenId;
        tokenId += 1n
    ) {
        yield {
            chainId: input.chainId,
            collectionId: input.collectionId,
            contract: input.contract,
            tokenId: tokenId.toString(),
            reason: input.reason,
            source: input.source,
        };
    }
}

// Prints the operator-facing command contract from the owned flags and defaults.
export function printCollectionExtensionArtifactRangeTriggerUsage(): void {
    console.log(
        [
            `Usage: yarn workspace @artgod/indexer run dev:collection-extension-trigger-range ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.CollectionId} <id> ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Contract} <0x...> ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.FromTokenId} <n> ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.ToTokenId} <n> [options]`,
            "",
            "Options:",
            `  ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.ChainId} <number>         Chain id (defaults to CHAIN_ID from .env)`,
            `  ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Reason} <text>             Job reason (defaults to ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Reason})`,
            `  ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Source} <text>             Job source (defaults to ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_DEFAULT.Source})`,
            `  ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Help}                      Show this help`,
        ].join("\n"),
    );
}

function normalizeContract(raw: string | undefined): string {
    if (!raw || !isAddressRef(raw)) {
        throw new Error(
            `Invalid ${COLLECTION_EXTENSION_ARTIFACT_RANGE_TRIGGER_CLI_FLAG.Contract}`,
        );
    }
    return normalizeAddressRef(raw);
}

function normalizeTokenId(raw: string | undefined, flag: string): bigint {
    const value = raw?.trim();
    if (!value || !/^\d+$/.test(value)) {
        throw new Error(`Invalid ${flag}`);
    }
    return BigInt(value);
}

function normalizeAttribution(
    raw: string | undefined,
    fallback: string,
): string {
    const value = raw?.trim();
    return value && value.length > 0 ? value : fallback;
}

function parseRequiredPositiveInteger(
    value: number | undefined,
    flag: string,
): number {
    if (value === undefined) {
        throw new Error(`${flag} is required`);
    }
    return parsePositiveInteger(value, flag);
}

function parsePositiveIntegerFlag(raw: string, flag: string): number {
    return parsePositiveInteger(Number(raw), flag);
}

function parsePositiveInteger(value: number, field: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive integer`);
    }
    return value;
}

function requireFlagValue(raw: string[], index: number, flag: string): string {
    const value = raw[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
