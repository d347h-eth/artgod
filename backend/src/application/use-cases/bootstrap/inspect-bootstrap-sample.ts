import {
    emptyBootstrapSampleMetadata,
    type BootstrapProbeObservation,
    type BootstrapProbeTokenCandidate,
    type BootstrapSampleMetadata,
    type BootstrapSampleInspectionRequest,
    type BootstrapSampleInspectionResponse,
    type BootstrapImageCacheSuggestion,
    type BootstrapProjectScopeSuggestion,
} from "@artgod/shared/bootstrap/probe";
import {
    BOOTSTRAP_ACTION_LABEL as Action,
    BOOTSTRAP_OUTPUT_STEP as Step,
    BOOTSTRAP_OUTPUT_STATUS as Status,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
import { bootstrapSampleCandidates } from "@artgod/shared/bootstrap/sample-selection";
import {
    parseBootstrapScope,
    bootstrapScopeModel,
    BootstrapScopeValidationError,
    type BootstrapScope,
} from "@artgod/shared/bootstrap/scope";
import { BOOTSTRAP_ENUMERATION_MODE } from "@artgod/shared/bootstrap/pipeline";
import { normalizeEvmTokenId } from "@artgod/shared/evm/token-id";
import {
    defaultImageCachePolicyConfig,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from "@artgod/shared/types";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import {
    resolveRequestedExtensionKey,
    type EmbeddedCollectionExtensionResolverPort,
} from "./create-bootstrap-run.js";
import { normalizeBootstrapProbeAddress } from "./probe-collection-contract.js";
import type { ChainRefResolverPort } from "./ports.js";
import { BootstrapValidationError } from "./types.js";

export interface BootstrapSampleInspectionPort {
    observation(
        reference?: BootstrapProbeObservation | null,
        report?: BootstrapOutputReporter,
    ): Promise<BootstrapProbeObservation>;
    verifyObservation(
        reference: BootstrapProbeObservation,
        report?: BootstrapOutputReporter,
    ): Promise<void>;
    checkOwnership(
        input: {
            address: string;
            tokenId: string;
            observation: BootstrapProbeObservation;
        },
        report?: BootstrapOutputReporter,
    ): Promise<BootstrapProbeTokenCandidate>;
    readMetadata(
        input: {
            address: string;
            tokenId: string;
            observation: BootstrapProbeObservation;
        },
        report?: BootstrapOutputReporter,
    ): Promise<BootstrapSampleMetadata>;
    /** Optional on-chain project lookup for an ownership-confirmed sample.
     * Unsupported families and failed advisory reads return null with output.
     */
    readProjectScope(
        input: {
            chainId: number;
            address: string;
            tokenId: string;
            observation: BootstrapProbeObservation;
        },
        report?: BootstrapOutputReporter,
    ): Promise<BootstrapProjectScopeSuggestion | null>;
}
export interface ProbeCollectionExtensionResolverPort extends EmbeddedCollectionExtensionResolverPort {
    resolveImageCachePolicyConfig(input: {
        chainId: number;
        extensionKey: CollectionExtensionKey;
    }): ImageCachePolicyConfig | null;
}

export class InspectBootstrapSampleUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolver: ChainRefResolverPort,
        private readonly inspection: BootstrapSampleInspectionPort,
        private readonly extensions: ProbeCollectionExtensionResolverPort,
        private readonly ipfsGatewayOrigin: string,
    ) {}

    async inspect(
        input: BootstrapSampleInspectionRequest & { chainRef: string },
        report?: BootstrapOutputReporter,
    ): Promise<BootstrapSampleInspectionResponse> {
        const chain = this.chainRefResolver.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const address = normalizeBootstrapProbeAddress(input.address);
        const requestedTokenId = optionalTokenId(input.requestedTokenId);
        const discoveredTokenId = optionalTokenId(input.discoveredTokenId);
        const scope = optionalScope(input.scope);
        const observation = await this.inspection.observation(
            input.observation,
            report,
        );
        const candidates: BootstrapProbeTokenCandidate[] = [];
        let projectScope: BootstrapProjectScopeSuggestion | null = null;
        const sample: BootstrapSampleInspectionResponse["sample"] = {
            ...emptyBootstrapSampleMetadata(),
            tokenId: null,
            source: null,
            ownership: null,
            candidates,
        };
        for (const candidate of bootstrapSampleCandidates({
            requestedTokenId,
            discoveredTokenId,
            scope,
        })) {
            // A caller's discovery hint is only a candidate, never trusted ownership evidence.
            const ownership = await this.inspection.checkOwnership(
                {
                    address,
                    tokenId: candidate.tokenId,
                    observation,
                },
                report,
            );
            candidates.push(ownership);
            if (requestedTokenId !== null || ownership.exists === true) {
                report?.({
                    step: Step.Sample,
                    status: Status.Succeeded,
                    message: `Sample token #${candidate.tokenId} · ${candidate.source.replaceAll("_", " ")}`,
                    tokenId: candidate.tokenId,
                });
                if (ownership.exists === true) {
                    const target = {
                        address,
                        tokenId: candidate.tokenId,
                        observation,
                    };
                    // Project facts do not depend on an available metadata server.
                    const [metadata, project] = await Promise.all([
                        this.inspection.readMetadata(target, report),
                        this.inspection.readProjectScope(
                            { ...target, chainId: chain.publicChainId },
                            report,
                        ),
                    ]);
                    Object.assign(sample, metadata);
                    projectScope = project;
                }
                Object.assign(sample, {
                    tokenId: candidate.tokenId,
                    source: candidate.source,
                    ownership,
                    candidates,
                });
                break;
            }
        }
        if (sample.tokenId === null)
            report?.({
                step: Step.Sample,
                status: Status.Failed,
                message: `No existing sample found. Enter a sample token ID and press ${Action.Inspect}.`,
            });
        await this.inspection.verifyObservation(observation, report);
        return {
            chain,
            address,
            observation,
            requestedTokenId,
            scope,
            sample,
            projectScope,
            ipfsGatewayOrigin: this.ipfsGatewayOrigin,
            imageCacheSuggestion: this.imageCacheSuggestion(
                chain.publicChainId,
                address,
                scope,
            ),
        };
    }

    private imageCacheSuggestion(
        chainId: number,
        address: string,
        scope: BootstrapScope | null,
    ): BootstrapImageCacheSuggestion {
        const fallback: BootstrapImageCacheSuggestion = {
            selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
            extensionKey: null,
            config: defaultImageCachePolicyConfig(),
        };
        if (!scope) return fallback;
        const extensionKey = resolveRequestedExtensionKey(
            this.extensions,
            chainId,
            address,
            {
                ...bootstrapScopeModel(scope).toPersistence(),
                explicitTokenIds:
                    scope.mode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
                        ? scope.tokenIds
                        : [],
            },
        );
        if (!extensionKey) return fallback;
        const config = this.extensions.resolveImageCachePolicyConfig({
            chainId,
            extensionKey,
        });
        return config
            ? {
                  selectedSource:
                      COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension,
                  extensionKey,
                  config,
              }
            : { ...fallback, extensionKey };
    }
}

function optionalTokenId(raw: string | null | undefined): string | null {
    if (
        raw === null ||
        raw === undefined ||
        (typeof raw === "string" && !raw.trim())
    )
        return null;
    const id = normalizeEvmTokenId(raw);
    if (id === null)
        throw new BootstrapValidationError(
            "Enter a valid decimal sample token ID.",
        );
    return id;
}

function optionalScope(raw: unknown): BootstrapScope | null {
    if (raw === undefined || raw === null) return null;
    try {
        return parseBootstrapScope(raw);
    } catch (error) {
        if (error instanceof BootstrapScopeValidationError)
            throw new BootstrapValidationError(error.message);
        throw error;
    }
}
