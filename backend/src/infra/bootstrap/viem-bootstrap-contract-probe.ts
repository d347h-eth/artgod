import {
    ERC721_OWNER_OF_FUNCTION,
    ERC721_OWNERSHIP_ABI,
    isErc721TokenAbsentError,
    normalizeErc721Owner,
} from "@artgod/shared/evm/erc721-ownership";
import { normalizeEvmTokenId } from "@artgod/shared/evm/token-id";
import {
    BOOTSTRAP_PROBE_READ_STATUS,
    emptyBootstrapSampleMetadata,
    type BootstrapContractFindings,
    type BootstrapProbeObservation,
    type BootstrapProbeInterfaceCheck,
    type BootstrapProbeTokenCandidate,
    type BootstrapProbeTotalSupply,
    type BootstrapSampleMetadata,
    type BootstrapTokenDiscovery,
} from "@artgod/shared/bootstrap/probe";
import {
    bootstrapTokenDiscovery,
    BOOTSTRAP_CONVENTIONAL_TOKEN_IDS,
} from "@artgod/shared/bootstrap/sample-selection";
import { inspectBootstrapMetadata } from "@artgod/shared/bootstrap/metadata";
import type { CollectionContractProbePort } from "../../application/use-cases/bootstrap/probe-collection-contract.js";
import type { BootstrapSampleInspectionPort } from "../../application/use-cases/bootstrap/inspect-bootstrap-sample.js";
import { BootstrapValidationError } from "../../application/use-cases/bootstrap/types.js";
import {
    parseJsonDataUriText,
    resolveTokenResourceUri,
} from "@artgod/shared/media/token-resource-uri";
import { getDefaultHttpFetchResilienceConfig } from "@artgod/shared/config/http-fetch-resilience";
import {
    fetchWithHttpResilience,
    HttpFetchStatusError,
    type HttpFetchResilienceConfig,
} from "@artgod/shared/network/http-fetch-resilience";
import {
    detectErc1967BeaconProxy,
    detectErc1967ImplementationProxy,
    detectEvmProxy,
    EVM_PROXY_STORAGE_SLOT,
    readErc1967BeaconAddress,
    type EvmProxyResolution,
} from "@artgod/shared/evm/proxy-detection";
import { bootstrapMetadataFetchFailure } from "../media/bootstrap-resource-failure.js";
import { bootstrapResourceObserver } from "./resource-output.js";
import {
    probeArtBlocksSharedContract,
    inspectArtBlocksProjectScope,
} from "./contract-families/art-blocks.js";
import {
    BOOTSTRAP_ACTION_LABEL as Action,
    BOOTSTRAP_OUTPUT_STEP as Step,
    BOOTSTRAP_OUTPUT_STATUS as Status,
    observeBootstrapStep,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
import { logger } from "@artgod/shared/utils";
import {
    BOOTSTRAP_TOKEN_URI_MAX_BYTES,
    BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT,
} from "@artgod/shared/config/bootstrap";

type Hex = `0x${string}`;
export type BootstrapProbeRpc = {
    getProbeBlock(blockNumber?: number): Promise<BootstrapProbeObservation>;
    getBytecode(address: Hex, blockNumber?: number): Promise<Hex | null>;
    getStorageAt(params: {
        address: Hex;
        slot: Hex;
        blockNumber?: number;
    }): Promise<Hex | null>;
    readContract<T = unknown>(params: {
        address: Hex;
        abi: readonly unknown[];
        functionName: string;
        args?: readonly unknown[];
        blockNumber?: number;
    }): Promise<T>;
};
type TokenUriPayload = { text: string; byteSize: number; truncated: boolean };

const ERC165_SUPPORTS_INTERFACE_FUNCTION = "supportsInterface";
const ERC721_TOKEN_BY_INDEX_FUNCTION = "tokenByIndex";
const ERC721_TOKEN_URI_FUNCTION = "tokenURI";
const ERC721_NAME_FUNCTION = "name";
const ERC721_TOTAL_SUPPLY_FUNCTION = "totalSupply";

const ERC165_ABI = [
    {
        name: ERC165_SUPPORTS_INTERFACE_FUNCTION,
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "bytes4", name: "interfaceId" }],
        outputs: [{ type: "bool" }],
    },
] as const;

const ERC721_ENUMERABLE_ABI = [
    {
        name: ERC721_TOKEN_BY_INDEX_FUNCTION,
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "index" }],
        outputs: [{ type: "uint256" }],
    },
] as const;

const ERC721_METADATA_ABI = [
    {
        name: ERC721_TOKEN_URI_FUNCTION,
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "string" }],
    },
] as const;

const ERC721_NAME_ABI = [
    {
        name: ERC721_NAME_FUNCTION,
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
] as const;

const ERC721_SUPPLY_ABI = [
    {
        name: ERC721_TOTAL_SUPPLY_FUNCTION,
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
] as const;

// Standard beacon proxy read used to resolve the current implementation address.
export const BEACON_PROXY_IMPLEMENTATION_FUNCTION = "implementation";

const BEACON_PROXY_ABI = [
    {
        name: BEACON_PROXY_IMPLEMENTATION_FUNCTION,
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
] as const;

// ERC165 interface id for ERC721 core.
const ERC721_INTERFACE_ID = "0x80ac58cd";
// ERC165 interface id for ERC721Enumerable.
const ERC721_ENUMERABLE_INTERFACE_ID = "0x780e9d63";

const DEFAULT_IPFS_GATEWAY_ORIGIN = "https://ipfs.io";
export const NON_CONTRACT_ADDRESS_PROBE_ERROR = "address is not a contract";

export class ViemBootstrapContractProbe
    implements CollectionContractProbePort, BootstrapSampleInspectionPort
{
    constructor(
        private readonly rpc: BootstrapProbeRpc,
        private readonly ipfsGatewayOrigin: string = DEFAULT_IPFS_GATEWAY_ORIGIN,
        private readonly fetchResilience: HttpFetchResilienceConfig = getDefaultHttpFetchResilienceConfig(),
    ) {}

    async observation(
        reference?: BootstrapProbeObservation | null,
        report?: BootstrapOutputReporter,
    ): Promise<BootstrapProbeObservation> {
        if (
            reference &&
            (!Number.isSafeInteger(reference.blockNumber) ||
                reference.blockNumber < 0 ||
                !/^0x[0-9a-f]{64}$/i.test(reference.blockHash))
        ) {
            throw new BootstrapValidationError(
                `Invalid probe observation. Press ${Action.Probe} again.`,
            );
        }
        const observed = await observeBootstrapStep(
            report,
            Step.Observation,
            reference
                ? `Verify block #${reference.blockNumber}`
                : "Read finalized block",
            () => this.rpc.getProbeBlock(reference?.blockNumber),
            (value) => ({
                status: Status.Succeeded,
                message: `Block #${value.blockNumber} · ${value.blockHash}`,
            }),
        );
        if (
            reference &&
            observed.blockHash.toLowerCase() !==
                reference.blockHash.toLowerCase()
        ) {
            throw new BootstrapValidationError(
                `The observed block changed. Press ${Action.Probe} again.`,
            );
        }
        return observed;
    }

    async verifyObservation(
        reference: BootstrapProbeObservation,
        report?: BootstrapOutputReporter,
    ): Promise<void> {
        await this.observation(reference, report);
    }

    async discoverContract(
        rawAddress: string,
        chainId: number,
        report?: BootstrapOutputReporter,
    ): Promise<BootstrapContractFindings> {
        const address = rawAddress as Hex;
        const observation = await this.observation(undefined, report);
        const blockNumber = observation.blockNumber;
        const bytecode = await observeBootstrapStep(
            report,
            Step.Code,
            `Contract code · ${address}`,
            () => this.rpc.getBytecode(address, blockNumber),
            (code) => ({
                status:
                    code && code !== "0x" ? Status.Succeeded : Status.Failed,
                message:
                    code && code !== "0x"
                        ? `Contract code · ${(code.length - 2) / 2} bytes`
                        : "No contract code. Check the address and chain.",
            }),
        );
        if (!bytecode || bytecode === "0x")
            throw new BootstrapValidationError(
                NON_CONTRACT_ADDRESS_PROBE_ERROR,
            );
        const [
            proxyResult,
            erc721,
            enumerable,
            name,
            totalSupply,
            sharedContract,
        ] = await Promise.all([
            observeBootstrapStep(
                report,
                Step.Proxy,
                "Check proxy implementation",
                () => this.readProxy(address, bytecode, blockNumber, report),
                (value) => ({
                    status: value.error ? Status.Failed : Status.Succeeded,
                    message: value.proxy
                        ? `Proxy implementation · ${value.proxy.implementationAddress}`
                        : value.error
                          ? "Proxy check unavailable. Check RPC settings and retry."
                          : "No recognized proxy found",
                }),
            ),
            observeBootstrapStep(
                report,
                Step.Erc721,
                `supportsInterface(${ERC721_INTERFACE_ID}) · ERC721`,
                () =>
                    this.readInterfaceSupport(
                        address,
                        ERC721_INTERFACE_ID,
                        blockNumber,
                    ),
                (value) => ({
                    status: value.error ? Status.Failed : Status.Succeeded,
                    message: `ERC721 · ${value.supported === null ? `check failed; retry ${Action.Probe}` : value.supported ? "supported" : "not supported"}`,
                }),
            ),
            observeBootstrapStep(
                report,
                Step.Enumerable,
                `supportsInterface(${ERC721_ENUMERABLE_INTERFACE_ID}) · ERC721Enumerable`,
                () =>
                    this.readInterfaceSupport(
                        address,
                        ERC721_ENUMERABLE_INTERFACE_ID,
                        blockNumber,
                    ),
                (value) => ({
                    status: value.error ? Status.Failed : Status.Succeeded,
                    message: `ERC721Enumerable · ${value.supported === null ? `check failed; retry ${Action.Probe}` : value.supported ? "supported" : "not supported"}`,
                }),
            ),
            observeBootstrapStep(
                report,
                Step.Name,
                "name()",
                () => this.readContractName(address, blockNumber),
                (value) => ({
                    status: value.error ? Status.Failed : Status.Succeeded,
                    message: value.value
                        ? `Contract name: ${value.value}`
                        : "Contract name unavailable. Enter the collection slug manually.",
                }),
            ),
            observeBootstrapStep(
                report,
                Step.Supply,
                "totalSupply()",
                () => this.readTotalSupply(address, blockNumber),
                (value) => ({
                    status: value.error ? Status.Failed : Status.Succeeded,
                    message:
                        value.value !== null
                            ? `Contract total supply: ${value.value}`
                            : "Contract total supply unavailable. Enter token scope manually.",
                }),
            ),
            probeArtBlocksSharedContract(
                this.rpc,
                { address, chainId, blockNumber },
                report,
            ),
        ]);
        const enumeration: BootstrapTokenDiscovery["enumeration"] = {
            checked: false,
            tokenId: null,
            error: null,
        };
        if (enumerable.supported === true && totalSupply.value !== "0") {
            enumeration.checked = true;
            report?.({
                step: Step.Enumeration,
                status: Status.Started,
                message: "tokenByIndex(0)",
            });
            try {
                const id = await this.rpc.readContract<bigint>({
                    address,
                    abi: ERC721_ENUMERABLE_ABI,
                    functionName: ERC721_TOKEN_BY_INDEX_FUNCTION,
                    args: [0n],
                    blockNumber,
                });
                enumeration.tokenId = normalizeEvmTokenId(id.toString());
                if (enumeration.tokenId === null)
                    throw new Error("Invalid enumeration token ID");
                report?.({
                    step: Step.Enumeration,
                    status: Status.Succeeded,
                    message: `tokenByIndex(0): ${enumeration.tokenId} · sample candidate`,
                });
            } catch (error) {
                enumeration.error = compactError(error);
                report?.({
                    step: Step.Enumeration,
                    status: Status.Failed,
                    message:
                        "tokenByIndex(0) failed. Choose a sample token ID manually.",
                });
            }
        } else {
            report?.({
                step: Step.Enumeration,
                status: Status.Skipped,
                message:
                    totalSupply.value === "0"
                        ? "Enumeration skipped: contract supply is zero."
                        : "Enumeration skipped: ERC721Enumerable support was not confirmed.",
            });
        }
        // The first enumeration entry is not necessarily the smallest ID. Check conventional IDs independently.
        const ids = [
            ...new Set([
                ...BOOTSTRAP_CONVENTIONAL_TOKEN_IDS,
                ...(enumeration.tokenId === null ? [] : [enumeration.tokenId]),
            ]),
        ];
        const candidates = await Promise.all(
            ids.map((tokenId) =>
                this.checkOwnership({ address, tokenId, observation }, report),
            ),
        );
        await this.verifyObservation(observation, report);
        return {
            observation,
            proxy: proxyResult.proxy,
            proxyError: proxyResult.error,
            contractName: name.value,
            contractNameError: name.error,
            erc721,
            enumerable,
            totalSupply,
            sharedContract,
            discovery: bootstrapTokenDiscovery(enumeration, candidates),
        };
    }

    async checkOwnership(
        input: {
            address: string;
            tokenId: string;
            observation: BootstrapProbeObservation;
        },
        report?: BootstrapOutputReporter,
    ): Promise<BootstrapProbeTokenCandidate> {
        report?.({
            step: Step.Ownership,
            status: Status.Started,
            message: `ownerOf(${input.tokenId})`,
        });
        try {
            const owner = await this.rpc.readContract<string>({
                address: input.address as Hex,
                abi: ERC721_OWNERSHIP_ABI,
                functionName: ERC721_OWNER_OF_FUNCTION,
                args: [BigInt(input.tokenId)],
                blockNumber: input.observation.blockNumber,
            });
            normalizeErc721Owner(owner);
            report?.({
                step: Step.Ownership,
                status: Status.Succeeded,
                message: `Token #${input.tokenId} owner: ${owner}`,
            });
            return { tokenId: input.tokenId, exists: true, error: null };
        } catch (error) {
            const absent = isErc721TokenAbsentError(error, input.tokenId);
            report?.({
                step: Step.Ownership,
                status: Status.Failed,
                message: absent
                    ? `Token #${input.tokenId} has no owner at block #${input.observation.blockNumber}. Choose another sample.`
                    : `ownerOf(${input.tokenId}) failed. Check RPC settings and retry.`,
            });
            logger.debug("Bootstrap ownership check failed", {
                address: input.address,
                tokenId: input.tokenId,
                error: compactError(error),
            });
            return {
                tokenId: input.tokenId,
                exists: absent ? false : null,
                error: absent
                    ? "This token has no owner at the observed block. Choose another sample token ID."
                    : "Ownership could not be checked. Retry inspection.",
            };
        }
    }

    readProjectScope(
        input: Parameters<BootstrapSampleInspectionPort["readProjectScope"]>[0],
        report?: BootstrapOutputReporter,
    ) {
        return inspectArtBlocksProjectScope(
            this.rpc,
            {
                address: input.address as Hex,
                chainId: input.chainId,
                blockNumber: input.observation.blockNumber,
                tokenId: input.tokenId,
            },
            report,
        );
    }

    async readMetadata(
        input: {
            address: string;
            tokenId: string;
            observation: BootstrapProbeObservation;
        },
        report?: BootstrapOutputReporter,
    ): Promise<BootstrapSampleMetadata> {
        const result = emptyBootstrapSampleMetadata();
        report?.({
            step: Step.TokenUri,
            status: Status.Started,
            message: `tokenURI(${input.tokenId})`,
        });
        try {
            const uri = await this.rpc.readContract<string>({
                address: input.address as Hex,
                abi: ERC721_METADATA_ABI,
                functionName: ERC721_TOKEN_URI_FUNCTION,
                args: [BigInt(input.tokenId)],
                blockNumber: input.observation.blockNumber,
            });
            if (typeof uri !== "string" || !uri.trim())
                throw new Error("tokenURI returned no URI");
            result.tokenUri = uri;
            report?.({
                step: Step.TokenUri,
                status: Status.Succeeded,
                message: `Token #${input.tokenId} URI`,
                ...(uri.startsWith("data:") ? { text: uri } : { url: uri }),
            });
        } catch (error) {
            logger.warn("Bootstrap tokenURI read failed", {
                address: input.address,
                tokenId: input.tokenId,
                error: compactError(error),
            });
            result.tokenUriError =
                "Token URI could not be read. Retry inspection or choose another sample token ID.";
            report?.({
                step: Step.TokenUri,
                status: Status.Failed,
                message: result.tokenUriError,
            });
            return result;
        }
        try {
            const payload = await fetchTokenUriPayload(
                result.tokenUri,
                this.ipfsGatewayOrigin,
                this.fetchResilience,
                BOOTSTRAP_TOKEN_URI_MAX_BYTES,
                report,
            );
            Object.assign(result, {
                tokenUriPayload: payload.text,
                tokenUriPayloadBytes: payload.byteSize,
                tokenUriPayloadTruncated: payload.truncated,
            });
            result.metadataError = inspectBootstrapMetadata({
                text: payload.text,
                ipfsGatewayOrigin: this.ipfsGatewayOrigin,
            }).error;
            report?.({
                step: Step.Metadata,
                status: Status.Succeeded,
                message: `Token #${input.tokenId} metadata · ${payload.byteSize} bytes`,
                text: payload.text,
            });
            report?.({
                step: Step.Json,
                status: result.metadataError ? Status.Failed : Status.Succeeded,
                message: result.metadataError ?? "Metadata JSON parsed",
            });
        } catch (error) {
            logger.warn("Bootstrap sample metadata fetch failed", {
                address: input.address,
                tokenId: input.tokenId,
                error: compactError(error),
            });
            result.tokenUriPayloadError = bootstrapMetadataFetchFailure(
                error,
                result.tokenUri,
            );
            report?.({
                step: Step.Metadata,
                status: Status.Failed,
                message: result.tokenUriPayloadError,
                url: result.tokenUri.startsWith("data:")
                    ? undefined
                    : (resolveTokenResourceUri(result.tokenUri, {
                          ipfsGatewayOrigin: this.ipfsGatewayOrigin,
                      }) ?? result.tokenUri),
            });
        }
        return result;
    }

    private async readProxy(
        address: Hex,
        bytecode: Hex,
        blockNumber: number,
        report?: BootstrapOutputReporter,
    ): Promise<{ proxy: EvmProxyResolution | null; error: string | null }> {
        const detected = detectEvmProxy(bytecode);
        report?.({
            step: Step.Proxy,
            status: Status.Succeeded,
            message: detected
                ? `Bytecode proxy · ${detected.implementationAddress}`
                : "No recognized proxy in bytecode; checking ERC1967 storage",
        });
        if (detected) return { proxy: detected, error: null };
        const errors: string[] = [];
        try {
            const value = await observeBootstrapStep(
                report,
                Step.Proxy,
                "Read ERC1967 implementation slot",
                () =>
                    this.rpc.getStorageAt({
                        address,
                        slot: EVM_PROXY_STORAGE_SLOT.Erc1967Implementation,
                        blockNumber,
                    }),
                (value) => ({
                    status: Status.Succeeded,
                    message: `ERC1967 implementation slot: ${value ?? "empty"}`,
                }),
            );
            const proxy = detectErc1967ImplementationProxy(value);
            if (proxy) return { proxy, error: null };
        } catch (error) {
            errors.push(compactError(error));
        }
        try {
            const slot = await observeBootstrapStep(
                report,
                Step.Proxy,
                "Read ERC1967 beacon slot",
                () =>
                    this.rpc.getStorageAt({
                        address,
                        slot: EVM_PROXY_STORAGE_SLOT.Erc1967Beacon,
                        blockNumber,
                    }),
                (value) => ({
                    status: Status.Succeeded,
                    message: `ERC1967 beacon slot: ${value ?? "empty"}`,
                }),
            );
            const beaconAddress = readErc1967BeaconAddress(slot);
            if (beaconAddress) {
                const implementationAddress = await observeBootstrapStep(
                    report,
                    Step.Proxy,
                    `Beacon implementation() · ${beaconAddress}`,
                    () =>
                        this.rpc.readContract<Hex>({
                            address: beaconAddress,
                            abi: BEACON_PROXY_ABI,
                            functionName: BEACON_PROXY_IMPLEMENTATION_FUNCTION,
                            blockNumber,
                        }),
                    (value) => ({
                        status: Status.Succeeded,
                        message: `Beacon implementation: ${value}`,
                    }),
                );
                return {
                    proxy: detectErc1967BeaconProxy({
                        beaconAddress,
                        implementationAddress,
                    }),
                    error: errors.length ? errors.join("; ") : null,
                };
            }
        } catch (error) {
            errors.push(compactError(error));
        }
        return { proxy: null, error: errors.length ? errors.join("; ") : null };
    }

    private async readInterfaceSupport(
        address: Hex,
        interfaceId: string,
        blockNumber: number,
    ): Promise<BootstrapProbeInterfaceCheck> {
        try {
            const supported = await this.rpc.readContract<boolean>({
                address,
                abi: ERC165_ABI,
                functionName: ERC165_SUPPORTS_INTERFACE_FUNCTION,
                args: [interfaceId],
                blockNumber,
            });
            if (typeof supported !== "boolean")
                throw new Error("Invalid interface response");
            return { supported, error: null };
        } catch (error) {
            return { supported: null, error: compactError(error) };
        }
    }

    private async readContractName(
        address: Hex,
        blockNumber: number,
    ): Promise<{ value: string | null; error: string | null }> {
        try {
            const name = await this.rpc.readContract<string>({
                address,
                abi: ERC721_NAME_ABI,
                functionName: ERC721_NAME_FUNCTION,
                blockNumber,
            });
            return { value: name.trim() || null, error: null };
        } catch (error) {
            return { value: null, error: compactError(error) };
        }
    }

    private async readTotalSupply(
        address: Hex,
        blockNumber: number,
    ): Promise<BootstrapProbeTotalSupply> {
        try {
            const value = await this.rpc.readContract<bigint>({
                address,
                abi: ERC721_SUPPLY_ABI,
                functionName: ERC721_TOTAL_SUPPLY_FUNCTION,
                blockNumber,
            });
            if (
                typeof value !== "bigint" ||
                normalizeEvmTokenId(value.toString()) === null
            )
                throw new Error("Invalid total supply");
            return {
                status: BOOTSTRAP_PROBE_READ_STATUS.Available,
                value: value.toString(),
                error: null,
                safeIntegerValue:
                    value <= BigInt(Number.MAX_SAFE_INTEGER)
                        ? Number(value)
                        : null,
                bootstrapRangeValue:
                    value > 0n &&
                    value <= BigInt(BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT)
                        ? Number(value)
                        : null,
            };
        } catch (error) {
            return {
                status: BOOTSTRAP_PROBE_READ_STATUS.Unavailable,
                value: null,
                safeIntegerValue: null,
                bootstrapRangeValue: null,
                error: compactError(error),
            };
        }
    }
}

async function fetchTokenUriPayload(
    uri: string,
    ipfsGatewayOrigin: string,
    fetchResilience: HttpFetchResilienceConfig,
    maxBytes: number,
    report?: BootstrapOutputReporter,
): Promise<TokenUriPayload> {
    if (uri.startsWith("data:")) {
        const text = parseJsonDataUriText(uri);
        return boundedTokenUriPayload(text, maxBytes);
    }

    const resolved = resolveTokenResourceUri(uri, { ipfsGatewayOrigin });
    if (!resolved || !/^https?:\/\//i.test(resolved)) {
        throw new Error("unsupported tokenURI scheme");
    }

    const response = await fetchWithHttpResilience({
        input: resolved,
        config: fetchResilience,
        observe: bootstrapResourceObserver(report, Step.Metadata),
        init: {
            headers: { accept: "application/json,text/plain;q=0.9,*/*;q=0.1" },
        },
    });
    if (!response.ok) {
        throw new HttpFetchStatusError(response.status);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(`tokenURI payload exceeds ${maxBytes} bytes`);
    }
    return await readResponseTextWithLimit(response, maxBytes);
}

async function readResponseTextWithLimit(
    response: Response,
    maxBytes: number,
): Promise<TokenUriPayload> {
    const body = response.body;
    if (!body) {
        const text = await response.text();
        return boundedTokenUriPayload(text, maxBytes);
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > maxBytes) {
            await reader.cancel();
            throw new Error(`tokenURI payload exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
    }

    return {
        text: Buffer.concat(chunks, received).toString("utf8"),
        byteSize: received,
        truncated: false,
    };
}

function boundedTokenUriPayload(
    text: string,
    maxBytes: number,
): TokenUriPayload {
    const byteSize = Buffer.byteLength(text, "utf8");
    if (byteSize > maxBytes) {
        throw new Error(`tokenURI payload exceeds ${maxBytes} bytes`);
    }
    return { text, byteSize, truncated: false };
}

function compactError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
        return error.message.trim().slice(0, 240);
    }
    return String(error).slice(0, 240);
}
