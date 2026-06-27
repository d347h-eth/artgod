import { SETTINGS_DEFAULTS } from "@artgod/shared/config/generated-settings-defaults";
import {
    API_CSRF_COOKIE_NAME,
    API_CSRF_HEADER_NAME,
    API_CSRF_ROUTE_PATH,
} from "@artgod/shared/http/api-security";
import {
    buildCreateBootstrapRunPath,
    buildProbeBootstrapCollectionPath,
} from "@artgod/shared/http/bootstrap-routes";
import {
    BOOTSTRAP_METADATA_MODE,
    type BootstrapMetadataMode,
    type BootstrapRunStatus,
} from "@artgod/shared/bootstrap/pipeline";
import {
    type ImageCacheMode,
} from "@artgod/shared/media/token-image-cache";
import type { CollectionCustomizationSourceKind } from "@artgod/shared/types";
import { COLLECTION_STANDARD } from "../domain/collections.js";

// CLI flags owned by the bootstrap trigger entrypoint.
export const BOOTSTRAP_TRIGGER_CLI_FLAG = {
    Address: "--address",
    Slug: "--slug",
    OpenSeaSlug: "--opensea-slug",
    ChainId: "--chain-id",
    ChainRef: "--chain-ref",
    BackendOrigin: "--backend-origin",
    DeploymentBlock: "--deployment-block",
    MetadataMode: "--metadata-mode",
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
    address?: string;
    slug?: string;
    openseaSlug?: string;
    chainId?: number;
    chainRef?: string;
    backendOrigin?: string;
    deploymentBlock?: number;
    metadataMode?: BootstrapMetadataMode;
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
};

type BootstrapManualInput =
    | {
          mode: "manual_token_ids";
          tokenIds: string[];
      }
    | {
          mode: "manual_range";
          startTokenId: string;
          totalSupply: number;
      };

export type BootstrapProbeApiResponse = {
    suggestedInput: {
        supportsEnumerable: boolean;
        manualInput: BootstrapManualInput | null;
        ready: boolean;
        warnings: string[];
    };
    imageCacheSuggestion: {
        selectedSource: CollectionCustomizationSourceKind;
        extensionKey: string | null;
        config: {
            imageCacheMode: ImageCacheMode;
            maxDimension: number | null;
        };
    };
};

export type BootstrapRunCreateBody = {
    slug: string;
    address: string;
    openseaSlug?: string;
    standard: typeof COLLECTION_STANDARD.Erc721;
    metadataMode: BootstrapMetadataMode;
    supportsEnumerable: boolean;
    manualInput?: BootstrapManualInput;
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

export type BootstrapTriggerResult = BootstrapRunCreateApiResponse & {
    requestBody: BootstrapRunCreateBody;
    probe: BootstrapProbeApiResponse;
};

type FetchLike = typeof fetch;

// Parses CLI flags without touching process state so tests can cover deploy commands.
export function parseBootstrapTriggerArgs(raw: string[]): BootstrapTriggerCliArgs {
    const parsed: BootstrapTriggerCliArgs = {};
    for (let i = 0; i < raw.length; i += 1) {
        const arg = raw[i];
        if (!arg) continue;
        switch (arg) {
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
        metadataMode:
            args.metadataMode ?? BOOTSTRAP_METADATA_MODE.BestEffort,
    };
}

// Builds the create-run body from the same probe fields used by the frontend form.
export function buildBootstrapRunCreateBody(
    input: BootstrapTriggerResolvedInput,
    probe: BootstrapProbeApiResponse,
): BootstrapRunCreateBody {
    if (!probe.suggestedInput.ready) {
        const warnings = probe.suggestedInput.warnings
            .map((warning) => warning.trim())
            .filter((warning) => warning.length > 0);
        const suffix = warnings.length ? `: ${warnings.join("; ")}` : "";
        throw new Error(`Bootstrap probe did not produce ready input${suffix}`);
    }

    const body: BootstrapRunCreateBody = {
        slug: input.slug,
        address: input.address,
        standard: COLLECTION_STANDARD.Erc721,
        metadataMode: input.metadataMode,
        supportsEnumerable: probe.suggestedInput.supportsEnumerable,
        imageCache: {
            selectedSource: probe.imageCacheSuggestion.selectedSource,
            imageCacheMode: probe.imageCacheSuggestion.config.imageCacheMode,
            maxDimension: probe.imageCacheSuggestion.config.maxDimension,
        },
    };

    if (input.openseaSlug) {
        body.openseaSlug = input.openseaSlug;
    }
    if (!probe.suggestedInput.supportsEnumerable) {
        if (!probe.suggestedInput.manualInput) {
            throw new Error("Bootstrap probe requires manual input");
        }
        body.manualInput = probe.suggestedInput.manualInput;
    }
    if (input.deploymentBlock !== null) {
        body.deploymentBlock = input.deploymentBlock;
    }

    return body;
}

// Runs the backend API flow used by the normal bootstrap UI.
export async function triggerBootstrapViaApi(
    input: BootstrapTriggerResolvedInput,
    fetchFn: FetchLike = globalThis.fetch,
): Promise<BootstrapTriggerResult> {
    assertFetchAvailable(fetchFn);

    const probe = await fetchBootstrapProbe(input, fetchFn);
    const requestBody = buildBootstrapRunCreateBody(input, probe);
    const csrfToken = await fetchCsrfToken(input.backendOrigin, fetchFn);
    const created = await createBootstrapRun(
        input,
        requestBody,
        csrfToken,
        fetchFn,
    );

    return {
        ...created,
        requestBody,
        probe,
    };
}

export function printBootstrapTriggerUsage(): void {
    console.log(
        [
            "Usage: yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> [options]",
            "",
            "Options:",
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.Slug} <slug>               Slug (defaults to address)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.OpenSeaSlug} <slug>       Optional OpenSea collection slug for orderbook bootstrap`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.ChainId} <number>         Chain id (defaults to CHAIN_ID or manifest default)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.ChainRef} <ref>           Backend chain route ref (defaults to chain id)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.BackendOrigin} <url>      Backend origin (defaults to http://127.0.0.1:<BACKEND_PORT>)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.DeploymentBlock} <number> Deployment block (optional)`,
            `  ${BOOTSTRAP_TRIGGER_CLI_FLAG.MetadataMode} <strict|best_effort> Metadata snapshot completion mode (defaults to best_effort)`,
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
        headers: {
            [BOOTSTRAP_TRIGGER_HEADER.ContentType]:
                BOOTSTRAP_TRIGGER_JSON_CONTENT_TYPE,
            [BOOTSTRAP_TRIGGER_HEADER.Cookie]: `${API_CSRF_COOKIE_NAME}=${csrfToken}`,
            [BOOTSTRAP_TRIGGER_HEADER.Origin]: input.backendOrigin,
            [API_CSRF_HEADER_NAME]: csrfToken,
        },
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
    if (!/^[a-z0-9-]+$/.test(value) || value.length > 80) {
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
    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
