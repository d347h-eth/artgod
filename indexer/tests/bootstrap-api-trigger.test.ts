import { describe, expect, it } from "vitest";
import {
    API_CSRF_COOKIE_NAME,
    API_CSRF_HEADER_NAME,
    API_CSRF_ROUTE_PATH,
} from "@artgod/shared/http/api-security";
import {
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import {
    TOKEN_METADATA_ANIMATION_SOURCE_FIELD,
} from "@artgod/shared/media/token-metadata-animation-source";
import {
    TOKEN_METADATA_IMAGE_SOURCE_FIELD,
} from "@artgod/shared/media/token-metadata-image-source";
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from "@artgod/shared/types";
import {
    BOOTSTRAP_TRIGGER_CLI_FLAG,
    BOOTSTRAP_TRIGGER_ENV_KEY,
    buildBootstrapRunCreateBody,
    parseBootstrapTriggerArgs,
    resolveBootstrapTriggerInput,
    triggerBootstrapViaApi,
    type BootstrapProbeApiResponse,
} from "../src/application/bootstrap-api-trigger.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";

const TEST_BACKEND_ORIGIN = "http://127.0.0.1:42710";
const TEST_ADDRESS = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const TEST_SLUG = "terraforms";
const TEST_OPENSEA_SLUG = "terraforms";
const TEST_EXTENSION_KEY = "terraforms";
const TEST_CHAIN_ID = 1;
const TEST_CHAIN_REF = "1";
const TEST_DEPLOYMENT_BLOCK = 13_823_015;
const TEST_CSRF_TOKEN = "0123456789abcdef0123456789abcdef";
const TEST_IMAGE_SOURCE_FIELD = TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image;
const TEST_ANIMATION_SOURCE_FIELD =
    TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl;

describe("bootstrap API trigger", () => {
    it("keeps the old Terraforms CLI shape while targeting the backend API", () => {
        const args = parseBootstrapTriggerArgs([
            BOOTSTRAP_TRIGGER_CLI_FLAG.ChainId,
            String(TEST_CHAIN_ID),
            BOOTSTRAP_TRIGGER_CLI_FLAG.Slug,
            TEST_SLUG,
            BOOTSTRAP_TRIGGER_CLI_FLAG.OpenSeaSlug,
            TEST_OPENSEA_SLUG,
            BOOTSTRAP_TRIGGER_CLI_FLAG.Address,
            TEST_ADDRESS,
            BOOTSTRAP_TRIGGER_CLI_FLAG.DeploymentBlock,
            String(TEST_DEPLOYMENT_BLOCK),
            BOOTSTRAP_TRIGGER_CLI_FLAG.MetadataMode,
            BOOTSTRAP_METADATA_MODE.Strict,
        ]);

        const input = resolveBootstrapTriggerInput(args, {
            [BOOTSTRAP_TRIGGER_ENV_KEY.BackendPort]: "42710",
            [BOOTSTRAP_TRIGGER_ENV_KEY.ChainId]: "5",
        });

        expect(input).toEqual({
            backendOrigin: TEST_BACKEND_ORIGIN,
            chainRef: TEST_CHAIN_REF,
            chainId: TEST_CHAIN_ID,
            address: TEST_ADDRESS,
            slug: TEST_SLUG,
            openseaSlug: TEST_OPENSEA_SLUG,
            deploymentBlock: TEST_DEPLOYMENT_BLOCK,
            metadataMode: BOOTSTRAP_METADATA_MODE.Strict,
        });
    });

    it("builds the create body from enumerable probe and extension image-cache policy", () => {
        const input = resolveBootstrapTriggerInput(
            {
                address: TEST_ADDRESS,
                slug: TEST_SLUG,
                chainId: TEST_CHAIN_ID,
                openseaSlug: TEST_OPENSEA_SLUG,
                deploymentBlock: TEST_DEPLOYMENT_BLOCK,
                metadataMode: BOOTSTRAP_METADATA_MODE.Strict,
            },
            {},
        );

        expect(buildBootstrapRunCreateBody(input, enumerableProbe())).toEqual({
            slug: TEST_SLUG,
            address: TEST_ADDRESS,
            openseaSlug: TEST_OPENSEA_SLUG,
            imageSourceField: TEST_IMAGE_SOURCE_FIELD,
            animationSourceField: TEST_ANIMATION_SOURCE_FIELD,
            standard: COLLECTION_STANDARD.Erc721,
            metadataMode: BOOTSTRAP_METADATA_MODE.Strict,
            supportsEnumerable: true,
            imageCache: {
                selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension,
                imageCacheMode: IMAGE_CACHE_MODE.Off,
                maxDimension: null,
            },
            deploymentBlock: TEST_DEPLOYMENT_BLOCK,
        });
    });

    it("carries probe-inferred manual range input when enumerable support is absent", () => {
        const input = resolveBootstrapTriggerInput(
            {
                address: TEST_ADDRESS,
                chainRef: "ethereum",
            },
            {},
        );

        expect(buildBootstrapRunCreateBody(input, manualRangeProbe())).toEqual(
            expect.objectContaining({
                supportsEnumerable: false,
                manualInput: {
                    mode: "manual_range",
                    startTokenId: "0",
                    totalSupply: 100,
                },
            }),
        );
    });

    it("probes, fetches csrf, and posts the frontend-shaped create request", async () => {
        const requests: Array<{
            url: string;
            init: RequestInit | undefined;
        }> = [];
        const fetchFn: typeof fetch = async (url, init) => {
            const requestUrl = String(url);
            requests.push({ url: requestUrl, init });
            const parsed = new URL(requestUrl);
            if (parsed.pathname.endsWith("/collections/bootstrap/probe")) {
                return jsonResponse(enumerableProbe());
            }
            if (parsed.pathname === API_CSRF_ROUTE_PATH) {
                return jsonResponse({ token: TEST_CSRF_TOKEN });
            }
            if (parsed.pathname.endsWith("/collections/bootstrap")) {
                return jsonResponse({
                    runId: 7,
                    collectionId: 42,
                    status: BOOTSTRAP_RUN_STATUS.Queued,
                    createdAt: "2026-06-27T00:00:00.000Z",
                });
            }
            return jsonResponse({ message: "unexpected route" }, 404);
        };

        const input = resolveBootstrapTriggerInput(
            {
                address: TEST_ADDRESS,
                slug: TEST_SLUG,
                chainId: TEST_CHAIN_ID,
                openseaSlug: TEST_OPENSEA_SLUG,
                deploymentBlock: TEST_DEPLOYMENT_BLOCK,
                metadataMode: BOOTSTRAP_METADATA_MODE.Strict,
            },
            {},
        );

        const result = await triggerBootstrapViaApi(input, fetchFn);

        expect(result).toMatchObject({
            runId: 7,
            collectionId: 42,
            status: BOOTSTRAP_RUN_STATUS.Queued,
        });
        expect(requests.map((request) => new URL(request.url).pathname)).toEqual(
            [
                "/api/1/collections/bootstrap/probe",
                API_CSRF_ROUTE_PATH,
                "/api/1/collections/bootstrap",
            ],
        );
        expect(new URL(requests[0]?.url ?? "").searchParams.get("standard")).toBe(
            COLLECTION_STANDARD.Erc721,
        );
        const createRequest = requests[2];
        expect(createRequest?.init?.method).toBe("POST");
        expect(createRequest?.init?.headers).toMatchObject({
            [API_CSRF_HEADER_NAME]: TEST_CSRF_TOKEN,
            cookie: `${API_CSRF_COOKIE_NAME}=${TEST_CSRF_TOKEN}`,
            origin: TEST_BACKEND_ORIGIN,
        });
        expect(JSON.parse(String(createRequest?.init?.body))).toEqual(
            result.requestBody,
        );
    });
});

function enumerableProbe(): BootstrapProbeApiResponse {
    return {
        firstToken: {
            imageSourceField: TEST_IMAGE_SOURCE_FIELD,
            animationSourceField: TEST_ANIMATION_SOURCE_FIELD,
        },
        suggestedInput: {
            supportsEnumerable: true,
            manualInput: null,
            ready: true,
            warnings: [],
        },
        imageCacheSuggestion: {
            selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension,
            extensionKey: TEST_EXTENSION_KEY,
            config: {
                imageCacheMode: IMAGE_CACHE_MODE.Off,
                maxDimension: null,
            },
        },
    };
}

function manualRangeProbe(): BootstrapProbeApiResponse {
    return {
        firstToken: {
            imageSourceField: TEST_IMAGE_SOURCE_FIELD,
            animationSourceField: null,
        },
        suggestedInput: {
            supportsEnumerable: false,
            manualInput: {
                mode: "manual_range",
                startTokenId: "0",
                totalSupply: 100,
            },
            ready: true,
            warnings: [],
        },
        imageCacheSuggestion: {
            selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
            extensionKey: null,
            config: {
                imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
                maxDimension: 1024,
            },
        },
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json",
        },
    });
}
