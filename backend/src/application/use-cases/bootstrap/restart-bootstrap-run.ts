import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import {
    BootstrapConflictError,
    BootstrapValidationError,
    type BootstrapManualInput,
    type CreateBootstrapRunOutput,
} from "./types.js";
import type {
    BootstrapCommandQueuePort,
    BootstrapRunsWritePort,
    ChainRefResolverPort,
} from "./ports.js";

export type RestartBootstrapRunInput = {
    chainRef: string;
    collectionRef: string;
    slug: string;
    address: string;
    standard: "erc721";
    metadataMode: "strict" | "best_effort";
    supportsEnumerable: boolean;
    manualInput?: BootstrapManualInput;
    deploymentBlock?: number;
};

export class RestartBootstrapRunUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
        private readonly bootstrapQueuePort: BootstrapCommandQueuePort,
    ) {}

    async restartRun(
        input: RestartBootstrapRunInput,
    ): Promise<CreateBootstrapRunOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.bootstrapRunsPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        if (!collection) {
            throw new ReadModelNotFoundError("Unknown collection_ref");
        }
        if (
            this.bootstrapRunsPort.hasActiveRun(
                chain.publicChainId,
                collection.collectionId,
            )
        ) {
            throw new BootstrapConflictError("Collection already bootstrapping");
        }

        const slug = normalizeSlug(input.slug);
        const address = normalizeAddress(input.address);
        if (address !== collection.address) {
            throw new BootstrapValidationError(
                "Restart address must match target collection",
            );
        }
        if (input.standard !== "erc721") {
            throw new BootstrapValidationError("Only erc721 is supported");
        }

        const enumeration = resolveEnumerationInput(
            input.supportsEnumerable,
            input.manualInput,
        );
        const updatedCollection =
            this.bootstrapRunsPort.upsertCollectionForBootstrap({
                chainId: chain.publicChainId,
                slug,
                address,
                standard: "erc721",
                deploymentBlock: input.deploymentBlock ?? null,
            });

        const run = this.bootstrapRunsPort.createRun({
            chainId: chain.publicChainId,
            collectionId: updatedCollection.collectionId,
            requestSlug: slug,
            requestAddress: address,
            requestStandard: "erc721",
            metadataMode: input.metadataMode,
            enumerationMode: enumeration.mode,
            manualTokenIdsJson: enumeration.manualTokenIdsJson,
            manualRangeStartTokenId: enumeration.manualRangeStartTokenId,
            manualRangeTotalSupply: enumeration.manualRangeTotalSupply,
            deploymentBlock: input.deploymentBlock ?? null,
        });
        this.bootstrapRunsPort.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: "run.restarted",
            eventLevel: "info",
            message: "Bootstrap run restarted",
            payloadJson: null,
        });
        await this.bootstrapQueuePort.publishBootstrapStart({
            chainId: run.chainId,
            runId: run.runId,
            collectionId: run.collectionId,
        });
        this.bootstrapRunsPort.updateRunStatus(run.runId, "queued");
        return {
            runId: run.runId,
            collectionId: run.collectionId,
            status: "queued",
            createdAt: run.createdAt,
        };
    }
}

function normalizeSlug(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!value) {
        throw new BootstrapValidationError("Slug is required");
    }
    if (!/^[a-z0-9-]+$/.test(value)) {
        throw new BootstrapValidationError("Invalid slug");
    }
    if (value.length > 80) {
        throw new BootstrapValidationError("Slug is too long");
    }
    return value;
}

function normalizeAddress(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(value)) {
        throw new BootstrapValidationError("Invalid address");
    }
    return value;
}

function resolveEnumerationInput(
    supportsEnumerable: boolean,
    manualInput: BootstrapManualInput | undefined,
): {
    mode: "enumerable" | "manual_token_ids" | "manual_range";
    manualTokenIdsJson: string | null;
    manualRangeStartTokenId: string | null;
    manualRangeTotalSupply: number | null;
} {
    if (supportsEnumerable) {
        return {
            mode: "enumerable",
            manualTokenIdsJson: null,
            manualRangeStartTokenId: null,
            manualRangeTotalSupply: null,
        };
    }
    if (!manualInput) {
        throw new BootstrapValidationError(
            "Manual input is required when enumerable support is disabled",
        );
    }
    if (manualInput.mode === "manual_token_ids") {
        if (manualInput.tokenIds.length === 0) {
            throw new BootstrapValidationError("Token IDs list cannot be empty");
        }
        if (manualInput.tokenIds.length > 50_000) {
            throw new BootstrapValidationError("Token IDs list is too large");
        }
        const normalized = manualInput.tokenIds.map((tokenId) =>
            normalizeTokenId(tokenId),
        );
        return {
            mode: "manual_token_ids",
            manualTokenIdsJson: JSON.stringify(normalized),
            manualRangeStartTokenId: null,
            manualRangeTotalSupply: null,
        };
    }

    const startTokenId = normalizeTokenId(manualInput.startTokenId);
    if (
        !Number.isInteger(manualInput.totalSupply) ||
        manualInput.totalSupply <= 0
    ) {
        throw new BootstrapValidationError("totalSupply must be a positive integer");
    }
    if (manualInput.totalSupply > 1_000_000) {
        throw new BootstrapValidationError("totalSupply is too large");
    }

    return {
        mode: "manual_range",
        manualTokenIdsJson: null,
        manualRangeStartTokenId: startTokenId,
        manualRangeTotalSupply: manualInput.totalSupply,
    };
}

function normalizeTokenId(raw: string): string {
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
        throw new BootstrapValidationError("Invalid token id");
    }
    if (value.length > 78) {
        throw new BootstrapValidationError("Token id is too large");
    }
    return value;
}
