import {
    parseBootstrapScope,
    bootstrapScopeContainsToken,
    type BootstrapScope,
} from "@artgod/shared/bootstrap/scope";
import {
    bootstrapSampleFailure,
    type BootstrapContractProbeResponse,
    type BootstrapSampleInspectionResponse,
} from "@artgod/shared/bootstrap/probe";
import { inspectBootstrapMetadata } from "@artgod/shared/bootstrap/metadata";
import {
    defaultImageCachePolicyConfig,
    IMAGE_CACHE_MODE,
} from "@artgod/shared/media/token-image-cache";
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from "@artgod/shared/types";
import {
    BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH,
    BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION,
    BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
} from "@artgod/shared/config/bootstrap";
import { SETTINGS_DEFAULTS } from "@artgod/shared/config/generated-settings-defaults";
import { normalizeEvmTokenId } from "@artgod/shared/evm/token-id";
import {
    API_CSRF_COOKIE_NAME,
    API_CSRF_HEADER_NAME,
    API_CSRF_ROUTE_PATH,
} from "@artgod/shared/http/api-security";
import {
    buildInspectBootstrapSamplePath,
    buildCreateBootstrapRunPath,
    buildProbeBootstrapCollectionPath,
    buildProbeBootstrapOpenSeaSlugPath,
} from "@artgod/shared/http/bootstrap-routes";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    type BootstrapMetadataMode,
    type BootstrapRunStatus,
} from "@artgod/shared/bootstrap/pipeline";
import {
    OPENSEA_COLLECTION_SLUG_PROBE_STATUS,
    type OpenSeaCollectionSlugProbeStatus,
} from "@artgod/shared/opensea/collection-slug-probe";
import { type ImageCacheMode } from "@artgod/shared/media/token-image-cache";
import type { CollectionCustomizationSourceKind } from "@artgod/shared/types";
import { COLLECTION_STANDARD } from "../domain/collections.js";

// CLI flags owned by the bootstrap trigger entrypoint.
export const BOOTSTRAP_TRIGGER_CLI_FLAG = {
    EntireContract: "--entire-contract",
    ImageSourceField: "--image-source-field",
    AnimationSourceField: "--animation-source-field",
    ImageCacheMode: "--image-cache-mode",
    ImageCacheMaxDimension: "--image-cache-max-dimension",
    Address: "--address",
    Slug: "--slug",
    OpenSeaSlug: "--opensea-slug",
    ChainId: "--chain-id",
    ChainRef: "--chain-ref",
    BackendOrigin: "--backend-origin",
    DeploymentBlock: "--deployment-block",
    MetadataMode: "--metadata-mode",
    SampleTokenId: "--sample-token-id",
    ManualTokenIds: "--manual-token-ids",
    ManualRangeStartTokenId: "--manual-range-start-token-id",
    ManualRangeTotalSupply: "--manual-range-total-supply",
    Help: "--help",
} as const;

// Env keys read by the bootstrap trigger CLI for local backend discovery.
export const BOOTSTRAP_TRIGGER_ENV_KEY = {
    BackendPort: "BACKEND_PORT",
    ChainId: "CHAIN_ID",
} as const;

const BOOTSTRAP_TRIGGER_DEFAULT_LOOPBACK_HOST = "127.0.0.1";
const BOOTSTRAP_TRIGGER_JSON_CONTENT_TYPE = "application/json";
const BOOTSTRAP_TRIGGER_HTTP_METHOD = {
    Get: "GET",
    Post: "POST",
} as const;
const BOOTSTRAP_TRIGGER_HEADER = {
    Accept: "accept",
    ContentType: "content-type",
    Cookie: "cookie",
    Origin: "origin",
} as const;

export type BootstrapTriggerCliArgs = {
    entireContract?: boolean;
    imageSourceField?: string;
    animationSourceField?: string;
    imageCacheMode?: ImageCacheMode;
    imageCacheMaxDimension?: number | null;
    address?: string;
    slug?: string;
    openseaSlug?: string;
    chainId?: number;
    chainRef?: string;
    backendOrigin?: string;
    deploymentBlock?: number;
    metadataMode?: BootstrapMetadataMode;
    sampleTokenId?: string;
    manualTokenIds?: string;
    manualRangeStartTokenId?: string;
    manualRangeTotalSupply?: number;
    help?: boolean;
};

export type BootstrapTriggerResolvedInput = {
    backendOrigin: string;
    chainRef: string;
    chainId: number;
    address: string;
    slug: string;
    openseaSlug: string | null;
    deploymentBlock: number | null;
    metadataMode: BootstrapMetadataMode;
    sampleTokenId: string | null;
    scope: BootstrapScope;
    imageSourceField: string | null;
    animationSourceField: string | null | undefined;
    imageCacheMode: ImageCacheMode | null;
    imageCacheMaxDimension: number | null | undefined;
};

export type BootstrapProbeApiResponse = BootstrapContractProbeResponse;

export type BootstrapRunCreateBody = {
    slug: string;
    address: string;
    openseaSlug?: string;
    imageSourceField: string;
    animationSourceField: string | null;
    standard: typeof COLLECTION_STANDARD.Erc721;
    metadataMode: BootstrapMetadataMode;
    scope: BootstrapScope;
    imageCache: {
        selectedSource: CollectionCustomizationSourceKind;
        imageCacheMode: ImageCacheMode;
        maxDimension: number | null;
    };
    deploymentBlock?: number;
};

export type BootstrapRunCreateApiResponse = {
    runId: number;
    collectionId: number;
    status: BootstrapRunStatus;
    createdAt: string;
};

type BootstrapOpenSeaSlugProbeApiResponse = {
    address: string | null;
    requestedSlug: string | null;
    status: OpenSeaCollectionSlugProbeStatus;
    slug: string | null;
    reason: string | null;
};

export type BootstrapTriggerResult = BootstrapRunCreateApiResponse & {
    requestBody: BootstrapRunCreateBody;
    probe: BootstrapProbeApiResponse | null;
    sample: BootstrapSampleInspectionResponse | null;
    warnings: string[];
};

type FetchLike = typeof fetch;

// Parses CLI flags without touching process state so tests can cover deploy commands.
export function parseBootstrapTriggerArgs(
    raw: string[],
): BootstrapTriggerCliArgs {
    const parsed: BootstrapTriggerCliArgs = {};
    for (let i = 0; i < raw.length; i += 1) {
        const arg = raw[i];
        if (!arg) continue;
        switch (arg) {
            case BOOTSTRAP_TRIGGER_CLI_FLAG.EntireContract:
                parsed.entireContract = true;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.ImageSourceField:
                parsed.imageSourceField = requireFlagValue(raw, i++, arg);
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.AnimationSourceField:
                parsed.animationSourceField = requireFlagValue(raw, i++, arg);
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.ImageCacheMode: {
                const value = requireFlagValue(raw, i++, arg);
                if (
                    !Object.values(IMAGE_CACHE_MODE).includes(
                        value as ImageCacheMode,
                    )
                )
                    throw new Error("Invalid image cache mode");
                parsed.imageCacheMode = value as ImageCacheMode;
                break;
            }
            case BOOTSTRAP_TRIGGER_CLI_FLAG.ImageCacheMaxDimension: {
                const value = requireFlagValue(raw, i++, arg);
                const dimension = value === "original" ? null : Number(value);
                if (
                    dimension !== null &&
                    (!Number.isInteger(dimension) ||
                        dimension < BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION ||
                        dimension > BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION)
                )
                    throw new Error("Invalid image cache max dimension");
                parsed.imageCacheMaxDimension = dimension;
                break;
            }
            case BOOTSTRAP_TRIGGER_CLI_FLAG.Help:
                parsed.help = true;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.Address:
                parsed.address = requireFlagValue(raw, i, arg);
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.Slug:
                parsed.slug = requireFlagValue(raw, i, arg);
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.OpenSeaSlug:
                parsed.openseaSlug = requireFlagValue(raw, i, arg);
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.ChainId:
                parsed.chainId = parsePositiveIntegerFlag(
                    requireFlagValue(raw, i, arg),
                    arg,
                );
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.ChainRef:
                parsed.chainRef = requireFlagValue(raw, i, arg);
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.BackendOrigin:
                parsed.backendOrigin = requireFlagValue(raw, i, arg);
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.DeploymentBlock:
                parsed.deploymentBlock = parsePositiveIntegerFlag(
                    requireFlagValue(raw, i, arg),
                    arg,
                );
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.MetadataMode:
                parsed.metadataMode = parseMetadataModeFlag(
                    requireFlagValue(raw, i, arg),
                );
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.SampleTokenId:
                parsed.sampleTokenId = requireFlagValue(raw, i, arg);
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.ManualTokenIds:
                parsed.manualTokenIds = requireFlagValue(raw, i, arg);
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.ManualRangeStartTokenId:
                parsed.manualRangeStartTokenId = requireFlagValue(raw, i, arg);
                i += 1;
                break;
            case BOOTSTRAP_TRIGGER_CLI_FLAG.ManualRangeTotalSupply:
                parsed.manualRangeTotalSupply = parsePositiveIntegerFlag(
                    requireFlagValue(raw, i, arg),
                    arg,
                );
                i += 1;
                break;
            default:
                throw new Error(`Unknown bootstrap trigger option: ${arg}`);
        }
    }
    return parsed;
}

// Resolves CLI/env values into the normalized API request context.
export function resolveBootstrapTriggerInput(
    args: BootstrapTriggerCliArgs,
    env: Record<string, string | undefined> = process.env,
): BootstrapTriggerResolvedInput {
    if (!args.address) {
        throw new Error(`${BOOTSTRAP_TRIGGER_CLI_FLAG.Address} is required`);
    }

    const chainId =
        args.chainId ??
        parsePositiveInteger(
            env[BOOTSTRAP_TRIGGER_ENV_KEY.ChainId],
            BOOTSTRAP_TRIGGER_ENV_KEY.ChainId,
            Number(SETTINGS_DEFAULTS.CHAIN_ID),
        );
    const address = normalizeAddress(args.address);
    const slug = normalizeSlug(args.slug ?? address);

    return {
        backendOrigin: resolveBackendOrigin(args.backendOrigin, env),
        chainRef: normalizeChainRef(args.chainRef ?? String(chainId)),
        chainId,
        address,
        slug,
        openseaSlug: normalizeOptionalSlug(args.openseaSlug),
        deploymentBlock: args.deploymentBlock ?? null,
        metadataMode: args.metadataMode ?? BOOTSTRAP_METADATA_MODE.BestEffort,
        sampleTokenId: normalizeOptionalTokenId(args.sampleTokenId),
        scope: resolveScope(args),
        imageSourceField: normalizeProbeField(args.imageSourceField),
        animationSourceField:
            args.animationSourceField === undefined
                ? undefined
                : normalizeProbeField(args.animationSourceField),
        imageCacheMode: args.imageCacheMode ?? null,
        imageCacheMaxDimension: args.imageCacheMaxDimension,
    };
}

// Entered scope and media settings remain authoritative even when optional checks fail.
export function buildBootstrapRunCreateBody(
    input: BootstrapTriggerResolvedInput,
    sample: BootstrapSampleInspectionResponse | null,
): BootstrapRunCreateBody {
    const fields = inspectBootstrapMetadata({
        text: sample?.sample.tokenUriPayload ?? null,
        ipfsGatewayOrigin: sample?.ipfsGatewayOrigin ?? "",
    });
    const imageSourceField = input.imageSourceField ?? fields.imageSourceField;
    if (!imageSourceField) {
        const failure = sample ? bootstrapSampleFailure(sample.sample) : null;
        throw new Error(
            [
                failure,
                "Enter --image-source-field to queue without readable sample metadata.",
            ]
                .filter(Boolean)
                .join(" "),
        );
    }
    const suggestion = sample?.imageCacheSuggestion;
    const config = suggestion?.config ?? defaultImageCachePolicyConfig();
    const imageCacheMode = input.imageCacheMode ?? config.imageCacheMode;
    const hasCacheOverride =
        input.imageCacheMode !== null ||
        input.imageCacheMaxDimension !== undefined;
    return {
        slug: input.slug,
        address: input.address,
        ...(input.openseaSlug ? { openseaSlug: input.openseaSlug } : {}),
        imageSourceField,
        animationSourceField:
            input.animationSourceField === undefined
                ? fields.animationSourceField
                : input.animationSourceField,
        standard: COLLECTION_STANDARD.Erc721,
        metadataMode: input.metadataMode,
        scope: parseBootstrapScope(input.scope),
        imageCache: {
            selectedSource: hasCacheOverride
                ? COLLECTION_CUSTOMIZATION_SOURCE_KIND.User
                : (suggestion?.selectedSource ??
                  COLLECTION_CUSTOMIZATION_SOURCE_KIND.User),
            imageCacheMode,
            maxDimension:
                imageCacheMode === IMAGE_CACHE_MODE.Off
                    ? null
                    : input.imageCacheMaxDimension !== undefined
                      ? input.imageCacheMaxDimension
                      : config.maxDimension,
        },
        ...(input.deploymentBlock !== null
            ? { deploymentBlock: input.deploymentBlock }
            : {}),
    };
}

export async function triggerBootstrapViaApi(
    input: BootstrapTriggerResolvedInput,
    fetchFn: FetchLike = globalThis.fetch,
): Promise<BootstrapTriggerResult> {
    assertFetchAvailable(fetchFn);
    let probe: BootstrapProbeApiResponse | null = null;
    let sample: BootstrapSampleInspectionResponse | null = null;
    const warnings: string[] = [];
    const csrfToken = await fetchCsrfToken(input.backendOrigin, fetchFn);
    // A fully specified manual definition needs no successful probe.
    if (!input.imageSourceField) {
        try {
            probe = await fetchBootstrapProbe(input, fetchFn);
        } catch (error) {
            warnings.push(
                error instanceof Error ? error.message : String(error),
            );
        }
        try {
            sample = await requestJson<BootstrapSampleInspectionResponse>(
                fetchFn,
                {
                    url:
                        input.backendOrigin +
                        buildInspectBootstrapSamplePath(input.chainRef),
                    method: BOOTSTRAP_TRIGGER_HTTP_METHOD.Post,
                    headers: csrfHeaders(input.backendOrigin, csrfToken),
                    body: JSON.stringify({
                        address: input.address,
                        scope: input.scope,
                        requestedTokenId: input.sampleTokenId,
                        discoveredTokenId: probe?.discovery.sampleTokenId,
                        observation: probe?.observation,
                    }),
                },
            );
        } catch (error) {
            warnings.push(
                error instanceof Error ? error.message : String(error),
            );
        }
    }
    let requestBody: BootstrapRunCreateBody;
    try {
        requestBody = buildBootstrapRunCreateBody(input, sample);
    } catch (error) {
        throw new Error(
            [
                ...warnings,
                error instanceof Error ? error.message : String(error),
            ].join("\n"),
            { cause: error },
        );
    }
    const sampleTokenId = input.sampleTokenId ?? sample?.sample.tokenId ?? null;
    if (
        input.openseaSlug &&
        (sampleTokenId === null ||
            !bootstrapScopeContainsToken(input.scope, sampleTokenId))
    ) {
        throw new Error(
            "Choose --sample-token-id inside the selected scope to verify --opensea-slug, or omit --opensea-slug to queue onchain only.",
        );
    }
    await verifyOpenSeaSlug(input, sampleTokenId, fetchFn);
    const created = await createBootstrapRun(
        input,
        requestBody,
        csrfToken,
        fetchFn,
    );
    return { ...created, requestBody, probe, sample, warnings };
}

export function printBootstrapTriggerUsage(): void {
    console.log(
        [
            "Usage: yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> [options]",
            "",
            "Options:",
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.EntireContract}          Explicitly select every contract token using ERC721Enumerable`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.ImageSourceField} <field> Required image property; enables manual queueing without a probe`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.AnimationSourceField} <field> Optional animation property; empty string skips animation`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.ImageCacheMode} <off|cache_once|refresh_on_metadata> Image cache policy`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.ImageCacheMaxDimension} <pixels|original> Cached image limit`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.Slug} <slug>               Slug (defaults to address)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.OpenSeaSlug} <slug>       Optional OpenSea collection slug for orderbook bootstrap`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.ChainId} <number>         Chain id (defaults to CHAIN_ID or manifest default)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.ChainRef} <ref>           Backend chain route ref (defaults to chain id)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.BackendOrigin} <url>      Backend origin (defaults to http://127.0.0.1:<BACKEND_PORT>)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.DeploymentBlock} <number> Deployment block (optional)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.MetadataMode} <strict|best_effort> Metadata snapshot completion mode (defaults to best_effort)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.SampleTokenId} <id>       Sample for inspection and OpenSea (optional)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.ManualTokenIds} <ids>     Comma- or space-separated explicit token IDs`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.ManualRangeStartTokenId} <id> Manual range first token ID`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.ManualRangeTotalSupply} <number> Manual range token count`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.Help}                     Show this help`,
        ].join("\n"),
    );
}

async function fetchBootstrapProbe(
    input: BootstrapTriggerResolvedInput,
    fetchFn: FetchLike,
): Promise<BootstrapProbeApiResponse> {
    const path = buildProbeBootstrapCollectionPath({
        chainRef: input.chainRef,
        address: input.address,
        standard: COLLECTION_STANDARD.Erc721,
    });
    return requestJson<BootstrapProbeApiResponse>(fetchFn, {
        url: `${input.backendOrigin}${path}`,
        method: BOOTSTRAP_TRIGGER_HTTP_METHOD.Get,
    });
}

async function verifyOpenSeaSlug(
    input: BootstrapTriggerResolvedInput,
    sampleTokenId: string | null,
    fetchFn: FetchLike,
): Promise<void> {
    if (!input.openseaSlug) {
        return;
    }
    const path = buildProbeBootstrapOpenSeaSlugPath({
        chainRef: input.chainRef,
        address: input.address,
        slug: input.openseaSlug,
        sampleTokenId: sampleTokenId ?? "",
    });
    const result = await requestJson<BootstrapOpenSeaSlugProbeApiResponse>(
        fetchFn,
        {
            url: `${input.backendOrigin}${path}`,
            method: BOOTSTRAP_TRIGGER_HTTP_METHOD.Get,
        },
    );
    if (
        result.status !== OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found ||
        result.address !== input.address ||
        result.requestedSlug !== input.openseaSlug ||
        result.slug !== input.openseaSlug
    ) {
        const reason = result.reason?.trim() || "OpenSea did not confirm it";
        throw new Error(
            `OpenSea slug verification failed for ${input.openseaSlug}: ${reason}`,
        );
    }
}

async function fetchCsrfToken(
    backendOrigin: string,
    fetchFn: FetchLike,
): Promise<string> {
    const payload = await requestJson<{ token?: string }>(fetchFn, {
        url: `${backendOrigin}${API_CSRF_ROUTE_PATH}`,
        method: BOOTSTRAP_TRIGGER_HTTP_METHOD.Get,
    });
    if (!payload || typeof payload !== "object" || !payload.token?.trim()) {
        throw new Error("Backend CSRF endpoint returned no token");
    }
    return payload.token.trim();
}

async function createBootstrapRun(
    input: BootstrapTriggerResolvedInput,
    body: BootstrapRunCreateBody,
    csrfToken: string,
    fetchFn: FetchLike,
): Promise<BootstrapRunCreateApiResponse> {
    return requestJson<BootstrapRunCreateApiResponse>(fetchFn, {
        url: `${input.backendOrigin}${buildCreateBootstrapRunPath(input.chainRef)}`,
        method: BOOTSTRAP_TRIGGER_HTTP_METHOD.Post,
        headers: csrfHeaders(input.backendOrigin, csrfToken),
        body: JSON.stringify(body),
    });
}

async function requestJson<T>(
    fetchFn: FetchLike,
    input: {
        url: string;
        method: (typeof BOOTSTRAP_TRIGGER_HTTP_METHOD)[keyof typeof BOOTSTRAP_TRIGGER_HTTP_METHOD];
        headers?: Record<string, string>;
        body?: string;
    },
): Promise<T> {
    const response = await fetchFn(input.url, {
        method: input.method,
        headers: {
            [BOOTSTRAP_TRIGGER_HEADER.Accept]:
                BOOTSTRAP_TRIGGER_JSON_CONTENT_TYPE,
            ...input.headers,
        },
        body: input.body,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new Error(
            formatApiError(input.method, input.url, response.status, payload),
        );
    }
    return payload as T;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text.trim()) {
        return null;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

function formatApiError(
    method: string,
    url: string,
    status: number,
    payload: unknown,
): string {
    const message =
        payload && typeof payload === "object" && "message" in payload
            ? String((payload as { message?: unknown }).message)
            : typeof payload === "string" && payload.trim()
              ? payload.trim()
              : null;
    const path = new URL(url).pathname;
    return `Bootstrap API ${method} ${path} failed with ${status}${message ? `: ${message}` : ""}`;
}

function assertFetchAvailable(
    fetchFn: FetchLike | undefined,
): asserts fetchFn is FetchLike {
    if (typeof fetchFn !== "function") {
        throw new Error("Global fetch is unavailable in this Node runtime");
    }
}

function resolveBackendOrigin(
    cliOrigin: string | undefined,
    env: Record<string, string | undefined>,
): string {
    if (cliOrigin?.trim()) {
        return normalizeBackendOrigin(cliOrigin);
    }
    const backendPort = parsePositiveInteger(
        env[BOOTSTRAP_TRIGGER_ENV_KEY.BackendPort],
        BOOTSTRAP_TRIGGER_ENV_KEY.BackendPort,
        Number(SETTINGS_DEFAULTS.BACKEND_PORT),
    );
    return `http://${BOOTSTRAP_TRIGGER_DEFAULT_LOOPBACK_HOST}:${backendPort}`;
}

function normalizeBackendOrigin(raw: string): string {
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        throw new Error(`Invalid ${BOOTSTRAP_TRIGGER_CLI_FLAG.BackendOrigin}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(
            `${BOOTSTRAP_TRIGGER_CLI_FLAG.BackendOrigin} must use http or https`,
        );
    }
    return parsed.origin;
}

function normalizeChainRef(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!value) {
        throw new Error("chain ref is required");
    }
    return value;
}

function normalizeAddress(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(value)) {
        throw new Error(`Invalid ${BOOTSTRAP_TRIGGER_CLI_FLAG.Address}`);
    }
    return value;
}

function normalizeSlug(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!value) {
        throw new Error(`Invalid ${BOOTSTRAP_TRIGGER_CLI_FLAG.Slug}`);
    }
    if (
        !/^[a-z0-9-]+$/.test(value) ||
        value.length > BOOTSTRAP_COLLECTION_SLUG_MAX_LENGTH
    ) {
        throw new Error(`Invalid ${BOOTSTRAP_TRIGGER_CLI_FLAG.Slug}`);
    }
    return value;
}

function normalizeOptionalSlug(raw: string | undefined): string | null {
    if (raw === undefined) {
        return null;
    }
    const value = raw.trim();
    if (!value) {
        return null;
    }
    return normalizeSlug(value);
}

function normalizeOptionalTokenId(raw: string | undefined): string | null {
    if (raw === undefined) {
        return null;
    }
    return normalizeDecimalTokenId(
        raw,
        BOOTSTRAP_TRIGGER_CLI_FLAG.SampleTokenId,
    );
}

function resolveScope(args: BootstrapTriggerCliArgs): BootstrapScope {
    const manualTokenIds = args.manualTokenIds?.trim();
    const rangeStartTokenId = args.manualRangeStartTokenId?.trim();
    const rangeTotalSupply = args.manualRangeTotalSupply;
    const hasTokenIds = Boolean(manualTokenIds);
    const hasRangeStart = Boolean(rangeStartTokenId);
    const hasRangeTotalSupply = rangeTotalSupply !== undefined;

    if (hasTokenIds && (hasRangeStart || hasRangeTotalSupply)) {
        throw new Error(
            `${BOOTSTRAP_TRIGGER_CLI_FLAG.ManualTokenIds} cannot be combined with manual range options`,
        );
    }
    if (hasRangeStart !== hasRangeTotalSupply) {
        throw new Error(
            `${BOOTSTRAP_TRIGGER_CLI_FLAG.ManualRangeStartTokenId} and ${BOOTSTRAP_TRIGGER_CLI_FLAG.ManualRangeTotalSupply} must be provided together`,
        );
    }
    if (
        args.entireContract &&
        (hasTokenIds || hasRangeStart || hasRangeTotalSupply)
    )
        throw new Error(
            "--entire-contract cannot be combined with a range or token list",
        );
    if (args.entireContract)
        return parseBootstrapScope({
            mode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
        });
    if (manualTokenIds)
        return parseBootstrapScope({
            mode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
            tokenIds: manualTokenIds.split(/[\s,]+/).filter(Boolean),
        });
    if (rangeStartTokenId && rangeTotalSupply !== undefined)
        return parseBootstrapScope({
            mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
            startTokenId: rangeStartTokenId,
            tokenCount: rangeTotalSupply,
        });
    throw new Error(
        "Choose --entire-contract, --manual-token-ids, or a manual range before queueing.",
    );
}

function normalizeDecimalTokenId(raw: string, option: string): string {
    const value = normalizeEvmTokenId(raw);
    if (value === null) {
        throw new Error(`${option} must contain decimal token IDs`);
    }
    return value;
}

function normalizeProbeField(raw: string | null | undefined): string | null {
    const value = raw?.trim();
    return value ? value : null;
}

function parseMetadataModeFlag(raw: string): BootstrapMetadataMode {
    if (
        raw === BOOTSTRAP_METADATA_MODE.Strict ||
        raw === BOOTSTRAP_METADATA_MODE.BestEffort
    ) {
        return raw;
    }
    throw new Error(`Invalid ${BOOTSTRAP_TRIGGER_CLI_FLAG.MetadataMode}`);
}

function parsePositiveIntegerFlag(raw: string, flag: string): number {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} must be a positive integer`);
    }
    return parsed;
}

function parsePositiveInteger(
    raw: string | undefined,
    name: string,
    fallback: number,
): number {
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function requireFlagValue(raw: string[], index: number, flag: string): string {
    const value = raw[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function csrfHeaders(
    backendOrigin: string,
    csrfToken: string,
): Record<string, string> {
    return {
        [BOOTSTRAP_TRIGGER_HEADER.ContentType]:
            BOOTSTRAP_TRIGGER_JSON_CONTENT_TYPE,
        [BOOTSTRAP_TRIGGER_HEADER.Cookie]: `${API_CSRF_COOKIE_NAME}=${csrfToken}`,
        [BOOTSTRAP_TRIGGER_HEADER.Origin]: backendOrigin,
        [API_CSRF_HEADER_NAME]: csrfToken,
    };
}
