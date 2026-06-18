import type {
    BootstrapProbeFirstToken,
    BootstrapProbeInterfaceCheck,
    BootstrapProbeTokenCandidate,
    BootstrapProbeTotalSupply,
    CollectionContractProbePort,
    CollectionContractProbeResult,
} from "../../application/use-cases/bootstrap/probe-collection-contract.js";
import {
    toBootstrapRangeTotalSupply,
    toSafeIntegerValue,
} from "../../application/use-cases/bootstrap/probe-collection-contract.js";
import {
    parseImageDataUriBuffer,
    parseJsonDataUriText,
    resolveTokenResourceUri,
} from "@artgod/shared/media/token-resource-uri";
import { getDefaultHttpFetchResilienceConfig } from "@artgod/shared/config/http-fetch-resilience";
import {
    fetchWithHttpResilience,
    type HttpFetchResilienceConfig,
} from "@artgod/shared/network/http-fetch-resilience";

type BootstrapProbeRpc = {
    readContract<T = unknown>(params: {
        address: `0x${string}`;
        abi: readonly unknown[];
        functionName: string;
        args?: readonly unknown[];
    }): Promise<T>;
};

type TokenUriPayload = {
    text: string;
    byteSize: number;
    truncated: boolean;
};

type TokenUriReadResult =
    | {
          ok: true;
          uri: string;
      }
    | {
          ok: false;
          error: string;
      };

type CandidateProbeResult = BootstrapProbeTokenCandidate & {
    tokenUri: string | null;
};

const ERC165_ABI = [
    {
        name: "supportsInterface",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "bytes4", name: "interfaceId" }],
        outputs: [{ type: "bool" }],
    },
] as const;

const ERC721_ENUMERABLE_ABI = [
    {
        name: "tokenByIndex",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "index" }],
        outputs: [{ type: "uint256" }],
    },
] as const;

const ERC721_METADATA_ABI = [
    {
        name: "tokenURI",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "string" }],
    },
] as const;

const ERC721_NAME_ABI = [
    {
        name: "name",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
] as const;

const ERC721_OWNER_ABI = [
    {
        name: "ownerOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "address" }],
    },
] as const;

const ERC721_SUPPLY_ABI = [
    {
        name: "totalSupply",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
] as const;

// ERC165 interface id for ERC721 core.
const ERC721_INTERFACE_ID = "0x80ac58cd";
// ERC165 interface id for ERC721Enumerable.
const ERC721_ENUMERABLE_INTERFACE_ID = "0x780e9d63";
// Preflight only needs enough payload to render a safe preview and estimate scale.
const MAX_TOKEN_URI_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_PROBE_BYTES = 25 * 1024 * 1024;
const DEFAULT_IPFS_GATEWAY_ORIGIN = "https://ipfs.io";

export class ViemBootstrapContractProbe implements CollectionContractProbePort {
    constructor(
        private readonly rpc: BootstrapProbeRpc,
        private readonly ipfsGatewayOrigin: string = DEFAULT_IPFS_GATEWAY_ORIGIN,
        private readonly fetchResilience: HttpFetchResilienceConfig =
            getDefaultHttpFetchResilienceConfig(),
    ) {}

    async probeErc721Contract(input: {
        address: string;
    }): Promise<CollectionContractProbeResult> {
        const address = input.address as `0x${string}`;
        const erc721 = await this.readInterfaceSupport(
            address,
            ERC721_INTERFACE_ID,
        );
        const enumerable = await this.readInterfaceSupport(
            address,
            ERC721_ENUMERABLE_INTERFACE_ID,
        );
        // Read name() only to suggest an editable local collection slug.
        const contractName = await this.readContractName(address);
        const totalSupply = await this.readTotalSupply(address);
        const firstToken = await this.probeFirstToken(address, enumerable);

        return {
            contractName,
            erc721,
            enumerable,
            totalSupply,
            firstToken,
        };
    }

    private async readInterfaceSupport(
        address: `0x${string}`,
        interfaceId: string,
    ): Promise<BootstrapProbeInterfaceCheck> {
        try {
            const supported = await this.rpc.readContract<boolean>({
                address,
                abi: ERC165_ABI,
                functionName: "supportsInterface",
                args: [interfaceId],
            });
            return {
                supported: Boolean(supported),
                error: null,
            };
        } catch (error) {
            return {
                supported: null,
                error: compactError(error),
            };
        }
    }

    private async readContractName(address: `0x${string}`): Promise<string | null> {
        try {
            const name = await this.rpc.readContract<string>({
                address,
                abi: ERC721_NAME_ABI,
                functionName: "name",
            });
            return name.trim() || null;
        } catch {
            return null;
        }
    }

    private async readTotalSupply(
        address: `0x${string}`,
    ): Promise<BootstrapProbeTotalSupply> {
        try {
            const value = await this.rpc.readContract<bigint>({
                address,
                abi: ERC721_SUPPLY_ABI,
                functionName: "totalSupply",
            });
            if (value <= 0n) {
                return unavailableTotalSupply("totalSupply is not positive");
            }
            return {
                status: "available",
                value: value.toString(),
                safeIntegerValue: toSafeIntegerValue(value),
                bootstrapRangeValue: toBootstrapRangeTotalSupply(value),
                error: null,
            };
        } catch (error) {
            return unavailableTotalSupply(compactError(error));
        }
    }

    private async probeFirstToken(
        address: `0x${string}`,
        enumerable: BootstrapProbeInterfaceCheck,
    ): Promise<BootstrapProbeFirstToken> {
        const candidates: BootstrapProbeTokenCandidate[] = [];
        if (enumerable.supported === true) {
            try {
                const tokenId = await this.rpc.readContract<bigint>({
                    address,
                    abi: ERC721_ENUMERABLE_ABI,
                    functionName: "tokenByIndex",
                    args: [0n],
                });
                return this.readFirstTokenMetadata(
                    address,
                    tokenId.toString(),
                    "token_by_index",
                    candidates,
                    null,
                );
            } catch {
                // Fall back to token id start probing below.
            }
        }

        for (const tokenId of ["0", "1"]) {
            const candidate = await this.probeTokenCandidate(address, tokenId);
            candidates.push({
                tokenId: candidate.tokenId,
                exists: candidate.exists,
                source: candidate.source,
                error: candidate.error,
            });
            if (candidate.exists) {
                return this.readFirstTokenMetadata(
                    address,
                    tokenId,
                    candidate.source === "token_uri"
                        ? "candidate_token_uri"
                        : "candidate_owner_of",
                    candidates,
                    candidate.tokenUri,
                );
            }
        }

        return {
            tokenId: null,
            source: null,
            tokenUri: null,
            tokenUriPayloadBytes: null,
            tokenUriPayloadTruncated: false,
            tokenUriPayloadError: null,
            name: null,
            image: null,
            imageBytes: null,
            imageBytesSource: null,
            imageContentType: null,
            imageBytesError: null,
            animationUrl: null,
            metadataError: "token ids 0 and 1 were not confirmed",
            candidates,
        };
    }

    private async probeTokenCandidate(
        address: `0x${string}`,
        tokenId: string,
    ): Promise<CandidateProbeResult> {
        const tokenUri = await this.readTokenUri(address, tokenId);
        if (tokenUri.ok) {
            return {
                tokenId,
                exists: true,
                source: "token_uri",
                error: null,
                tokenUri: tokenUri.uri,
            };
        }

        try {
            await this.rpc.readContract<string>({
                address,
                abi: ERC721_OWNER_ABI,
                functionName: "ownerOf",
                args: [BigInt(tokenId)],
            });
            return {
                tokenId,
                exists: true,
                source: "owner_of",
                error: tokenUri.error,
                tokenUri: null,
            };
        } catch (error) {
            return {
                tokenId,
                exists: false,
                source: null,
                error: `${tokenUri.error}; ownerOf: ${compactError(error)}`,
                tokenUri: null,
            };
        }
    }

    private async readFirstTokenMetadata(
        address: `0x${string}`,
        tokenId: string,
        source: BootstrapProbeFirstToken["source"],
        candidates: BootstrapProbeTokenCandidate[],
        knownTokenUri: string | null,
    ): Promise<BootstrapProbeFirstToken> {
        const tokenUri = knownTokenUri ?? (await this.readTokenUri(address, tokenId));
        if (typeof tokenUri !== "string" && !tokenUri.ok) {
            return emptyFirstTokenWithError(
                tokenId,
                source,
                candidates,
                tokenUri.error,
            );
        }

        const uri = typeof tokenUri === "string" ? tokenUri : tokenUri.uri;
        try {
            const payload = await fetchTokenUriPayload(
                uri,
                this.ipfsGatewayOrigin,
                this.fetchResilience,
                MAX_TOKEN_URI_PAYLOAD_BYTES,
            );
            const metadata = parseMetadataPayload(payload.text);
            const image = resolveDisplayUrl(metadata.image, this.ipfsGatewayOrigin);
            const imageSize = image
                ? await probeMediaSize(
                      image,
                      MAX_MEDIA_PROBE_BYTES,
                      this.fetchResilience,
                  )
                : null;
            return {
                tokenId,
                source,
                tokenUri: uri,
                tokenUriPayloadBytes: payload.byteSize,
                tokenUriPayloadTruncated: payload.truncated,
                tokenUriPayloadError: null,
                name: metadata.name,
                image,
                imageBytes: imageSize?.bytes ?? null,
                imageBytesSource: imageSize?.source ?? null,
                imageContentType: imageSize?.contentType ?? null,
                imageBytesError: imageSize?.error ?? null,
                animationUrl: resolveDisplayUrl(
                    metadata.animationUrl,
                    this.ipfsGatewayOrigin,
                ),
                metadataError: metadata.error,
                candidates,
            };
        } catch (error) {
            return {
                tokenId,
                source,
                tokenUri: uri,
                tokenUriPayloadBytes: null,
                tokenUriPayloadTruncated: false,
                tokenUriPayloadError: compactError(error),
                name: null,
                image: null,
                imageBytes: null,
                imageBytesSource: null,
                imageContentType: null,
                imageBytesError: null,
                animationUrl: null,
                metadataError: null,
                candidates,
            };
        }
    }

    private async readTokenUri(
        address: `0x${string}`,
        tokenId: string,
    ): Promise<TokenUriReadResult> {
        try {
            const uri = await this.rpc.readContract<string>({
                address,
                abi: ERC721_METADATA_ABI,
                functionName: "tokenURI",
                args: [BigInt(tokenId)],
            });
            if (!uri.trim()) {
                return {
                    ok: false,
                    error: "tokenURI returned an empty string",
                };
            }
            return {
                ok: true,
                uri,
            };
        } catch (error) {
            return {
                ok: false,
                error: `tokenURI: ${compactError(error)}`,
            };
        }
    }
}

function unavailableTotalSupply(error: string): BootstrapProbeTotalSupply {
    return {
        status: "unavailable",
        value: null,
        safeIntegerValue: null,
        bootstrapRangeValue: null,
        error,
    };
}

function emptyFirstTokenWithError(
    tokenId: string,
    source: BootstrapProbeFirstToken["source"],
    candidates: BootstrapProbeTokenCandidate[],
    error: string,
): BootstrapProbeFirstToken {
    return {
        tokenId,
        source,
        tokenUri: null,
        tokenUriPayloadBytes: null,
        tokenUriPayloadTruncated: false,
        tokenUriPayloadError: error,
        name: null,
        image: null,
        imageBytes: null,
        imageBytesSource: null,
        imageContentType: null,
        imageBytesError: null,
        animationUrl: null,
        metadataError: null,
        candidates,
    };
}

async function fetchTokenUriPayload(
    uri: string,
    ipfsGatewayOrigin: string,
    fetchResilience: HttpFetchResilienceConfig,
    maxBytes: number,
): Promise<TokenUriPayload> {
    if (uri.startsWith("data:")) {
        const text = parseJsonDataUriText(uri);
        return {
            text,
            byteSize: Buffer.byteLength(text, "utf8"),
            truncated: false,
        };
    }

    const resolved = resolveDisplayUrl(uri, ipfsGatewayOrigin);
    if (!resolved || !/^https?:\/\//i.test(resolved)) {
        throw new Error("unsupported tokenURI scheme");
    }

    const response = await fetchWithHttpResilience({
        input: resolved,
        config: fetchResilience,
        init: {
            headers: { accept: "application/json,text/plain;q=0.9,*/*;q=0.1" },
        },
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
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
        return {
            text,
            byteSize: Buffer.byteLength(text, "utf8"),
            truncated: false,
        };
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

function parseMetadataPayload(text: string): {
    name: string | null;
    image: string | null;
    animationUrl: string | null;
    error: string | null;
} {
    try {
        const raw = JSON.parse(text) as Record<string, unknown>;
        return {
            name: asString(raw.name),
            image: asString(raw.image ?? raw.image_url),
            animationUrl: asString(raw.animation_url ?? raw.animationUrl),
            error: null,
        };
    } catch (error) {
        return {
            name: null,
            image: null,
            animationUrl: null,
            error: compactError(error),
        };
    }
}

function resolveDisplayUrl(
    value: string | null,
    ipfsGatewayOrigin: string,
): string | null {
    return resolveTokenResourceUri(value, { ipfsGatewayOrigin });
}

async function probeMediaSize(
    uri: string,
    maxBytes: number,
    fetchResilience: HttpFetchResilienceConfig,
): Promise<{
    bytes: number | null;
    source: "content_length" | "download" | "data_uri" | null;
    contentType: string | null;
    error: string | null;
}> {
    if (uri.startsWith("data:")) {
        try {
            const data = parseImageDataUriBuffer(uri);
            return {
                bytes: data.buffer.byteLength,
                source: "data_uri",
                contentType: data.contentType,
                error: null,
            };
        } catch (error) {
            return emptyMediaSizeError(error);
        }
    }

    if (!/^https?:\/\//i.test(uri)) {
        return {
            bytes: null,
            source: null,
            contentType: null,
            error: "unsupported image scheme",
        };
    }

    const head = await readContentLength(uri, fetchResilience);
    if (head.bytes !== null) {
        return head;
    }

    return downloadMediaSize(uri, maxBytes, fetchResilience);
}

async function readContentLength(
    uri: string,
    fetchResilience: HttpFetchResilienceConfig,
): Promise<{
    bytes: number | null;
    source: "content_length" | null;
    contentType: string | null;
    error: string | null;
}> {
    try {
        const response = await fetchWithHttpResilience({
            input: uri,
            config: fetchResilience,
            init: {
                method: "HEAD",
                headers: { accept: "image/*,*/*;q=0.1" },
            },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const contentLength = Number(response.headers.get("content-length"));
        return {
            bytes:
                Number.isFinite(contentLength) && contentLength >= 0
                    ? contentLength
                    : null,
            source:
                Number.isFinite(contentLength) && contentLength >= 0
                    ? "content_length"
                    : null,
            contentType: response.headers.get("content-type"),
            error: null,
        };
    } catch (error) {
        return {
            bytes: null,
            source: null,
            contentType: null,
            error: compactError(error),
        };
    }
}

async function downloadMediaSize(
    uri: string,
    maxBytes: number,
    fetchResilience: HttpFetchResilienceConfig,
): Promise<{
    bytes: number | null;
    source: "download" | null;
    contentType: string | null;
    error: string | null;
}> {
    try {
        const response = await fetchWithHttpResilience({
            input: uri,
            config: fetchResilience,
            init: {
                headers: { accept: "image/*,*/*;q=0.1" },
            },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const payload = await readResponseBytesWithLimit(response, maxBytes);
        return {
            bytes: payload.byteLength,
            source: "download",
            contentType: response.headers.get("content-type"),
            error: null,
        };
    } catch (error) {
        return emptyMediaSizeError(error);
    }
}

async function readResponseBytesWithLimit(
    response: Response,
    maxBytes: number,
): Promise<{ byteLength: number }> {
    const body = response.body;
    if (!body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > maxBytes) {
            throw new Error(`image payload exceeds ${maxBytes} bytes`);
        }
        return { byteLength: buffer.byteLength };
    }

    const reader = body.getReader();
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > maxBytes) {
            throw new Error(`image payload exceeds ${maxBytes} bytes`);
        }
    }
    return { byteLength: received };
}

function emptyMediaSizeError(error: unknown): {
    bytes: null;
    source: null;
    contentType: null;
    error: string;
} {
    return {
        bytes: null,
        source: null,
        contentType: null,
        error: compactError(error),
    };
}

function asString(value: unknown): string | null {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return null;
}

function compactError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
        return error.message.trim().slice(0, 240);
    }
    return String(error).slice(0, 240);
}
