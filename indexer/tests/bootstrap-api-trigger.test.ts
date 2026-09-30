import { describe, expect, it, vi } from "vitest";
import {
    API_CSRF_HEADER_NAME,
    API_CSRF_ROUTE_PATH,
} from "@artgod/shared/http/api-security";
import {
    BOOTSTRAP_ENUMERATION_MODE as Mode,
    BOOTSTRAP_RUN_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import {
    BOOTSTRAP_API_ROUTE_TEMPLATE,
    buildInspectBootstrapSamplePath,
    buildProbeBootstrapCollectionPath,
} from "@artgod/shared/http/bootstrap-routes";
import { OPENSEA_COLLECTION_SLUG_PROBE_STATUS } from "@artgod/shared/opensea/collection-slug-probe";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import {
    BOOTSTRAP_CONTRACT_CASES,
    BOOTSTRAP_TEST_ADDRESS as ADDRESS,
    bootstrapTestContract,
    bootstrapTestSample,
} from "@artgod/shared/testing/bootstrap-probe";
import {
    BOOTSTRAP_TRIGGER_CLI_FLAG as Flag,
    parseBootstrapTriggerArgs,
    resolveBootstrapTriggerInput,
    buildBootstrapRunCreateBody,
    triggerBootstrapViaApi,
} from "../src/application/bootstrap-api-trigger.js";

const origin = "http://127.0.0.1:42710";
const created = {
    runId: 7,
    collectionId: 9,
    status: BOOTSTRAP_RUN_STATUS.Requested,
    createdAt: "2026-01-01T00:00:00Z",
};
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
const manual = () =>
    resolveBootstrapTriggerInput(
        {
            address: ADDRESS,
            slug: "example",
            manualRangeStartTokenId: "0",
            manualRangeTotalSupply: 1000,
            imageSourceField: "image",
        },
        {},
    );

describe("bootstrap API trigger", () => {
    it("parses explicit scope, sample and media/cache choices", () => {
        const args = parseBootstrapTriggerArgs([
            Flag.Address,
            ADDRESS,
            Flag.EntireContract,
            Flag.SampleTokenId,
            "00042",
            Flag.ImageSourceField,
            "custom",
            Flag.AnimationSourceField,
            "generator_url",
            Flag.ImageCacheMode,
            IMAGE_CACHE_MODE.Off,
            Flag.ImageCacheMaxDimension,
            "original",
        ]);
        const input = resolveBootstrapTriggerInput(args, {});
        expect(input.scope).toEqual({ mode: Mode.Enumerable });
        expect(input.sampleTokenId).toBe("42");
        expect(buildBootstrapRunCreateBody(input, null)).toMatchObject({
            scope: { mode: Mode.Enumerable },
            imageSourceField: "custom",
            animationSourceField: "generator_url",
            imageCache: {
                imageCacheMode: IMAGE_CACHE_MODE.Off,
                maxDimension: null,
            },
        });
    });
    it.each(BOOTSTRAP_CONTRACT_CASES)(
        "keeps $name declared scope regardless of global findings",
        (c) => {
            const input = resolveBootstrapTriggerInput(
                {
                    address: c.address,
                    slug: c.name,
                    manualRangeStartTokenId: c.start,
                    manualRangeTotalSupply: c.count,
                    imageSourceField: "custom",
                    sampleTokenId: "999999999",
                },
                {},
            );
            for (const sample of [null, bootstrapTestSample()]) {
                expect(
                    buildBootstrapRunCreateBody(input, sample),
                ).toMatchObject({
                    imageSourceField: "custom",
                    scope: {
                        mode: Mode.ManualRange,
                        startTokenId: c.start,
                        tokenCount: c.count,
                    },
                });
            }
        },
    );
    it("deduplicates equivalent IDs and rejects ambiguous/invalid scope", () => {
        const input = resolveBootstrapTriggerInput(
            { address: ADDRESS, manualTokenIds: "001, 1 2" },
            {},
        );
        expect(input.scope).toEqual({
            mode: Mode.ManualTokenIds,
            tokenIds: ["1", "2"],
        });
        for (const args of [
            {},
            { entireContract: true, manualTokenIds: "1" },
            { manualTokenIds: "invalid" },
            { manualRangeStartTokenId: "0" },
            { manualRangeStartTokenId: "0", manualRangeTotalSupply: 1000001 },
        ]) {
            expect(() =>
                resolveBootstrapTriggerInput({ address: ADDRESS, ...args }, {}),
            ).toThrow();
        }
        expect(() => parseBootstrapTriggerArgs(["--unknown"])).toThrow(
            "Unknown",
        );
        expect(() => parseBootstrapTriggerArgs([Flag.Address])).toThrow(
            "requires",
        );
        expect(() =>
            parseBootstrapTriggerArgs([Flag.ImageCacheMaxDimension, "1"]),
        ).toThrow("Invalid");
        expect(() =>
            parseBootstrapTriggerArgs([Flag.ImageCacheMode, "bad"]),
        ).toThrow("Invalid");
    });
    it("queues a complete manual definition without any probe request", async () => {
        const calls: string[] = [];
        const fetcher = vi.fn(
            async (url: string | URL | Request, init?: RequestInit) => {
                const path = new URL(String(url)).pathname;
                calls.push(path);
                if (path === API_CSRF_ROUTE_PATH)
                    return json({ token: "csrf" });
                expect(path).toBe("/api/1/collections/bootstrap");
                expect(
                    new Headers(init?.headers).get(API_CSRF_HEADER_NAME),
                ).toBe("csrf");
                expect(JSON.parse(init?.body as string).scope).toEqual(
                    manual().scope,
                );
                return json(created);
            },
        ) as typeof fetch;
        const result = await triggerBootstrapViaApi(manual(), fetcher);
        expect(result.runId).toBe(7);
        expect(calls).toEqual([
            API_CSRF_ROUTE_PATH,
            "/api/1/collections/bootstrap",
        ]);
        expect(result.probe).toBeNull();
    });
    it("uses separate discovery and inspection when media fields are omitted", async () => {
        const input = { ...manual(), imageSourceField: null };
        const calls: string[] = [];
        const fetcher = vi.fn(
            async (url: string | URL | Request, init?: RequestInit) => {
                const path = new URL(String(url)).pathname;
                calls.push(path);
                if (path === API_CSRF_ROUTE_PATH)
                    return json({ token: "csrf" });
                if (path.endsWith("/probe"))
                    return json(bootstrapTestContract());
                if (path === buildInspectBootstrapSamplePath(input.chainRef)) {
                    expect(JSON.parse(init?.body as string)).toMatchObject({
                        scope: input.scope,
                        requestedTokenId: null,
                        discoveredTokenId: "0",
                    });
                    return json(bootstrapTestSample());
                }
                return json(created);
            },
        ) as typeof fetch;
        const result = await triggerBootstrapViaApi(input, fetcher);
        expect(result.requestBody.imageSourceField).toBe("image");
        expect(result.requestBody.scope).toEqual(input.scope);
        expect(calls).toHaveLength(4);
    });
    it("gives a manual recovery action after optional probe/metadata failures", async () => {
        const fetcher = vi.fn(async (url: string | URL | Request) =>
            String(url).endsWith(API_CSRF_ROUTE_PATH)
                ? json({ token: "csrf" })
                : json({ message: "HTTP 429" }, 502),
        ) as typeof fetch;
        await expect(
            triggerBootstrapViaApi(
                { ...manual(), imageSourceField: null },
                fetcher,
            ),
        ).rejects.toThrow(/HTTP 429[\s\S]*--image-source-field/);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it("preserves explicit omission of animation and metadata failure details", () => {
        const args = parseBootstrapTriggerArgs([
            Flag.Address,
            ADDRESS,
            Flag.EntireContract,
            Flag.AnimationSourceField,
            "",
        ]);
        const sample = bootstrapTestSample();
        sample.sample.tokenUriPayload = JSON.stringify({
            image: "ipfs://sample/image.png",
            animation_url: "ipfs://sample/art.html",
        });
        expect(
            buildBootstrapRunCreateBody(
                resolveBootstrapTriggerInput(args, {}),
                sample,
            ).animationSourceField,
        ).toBeNull();
        sample.sample.tokenUriPayload = null;
        sample.sample.tokenUriPayloadError =
            "Metadata download failed (HTTP 429).";
        expect(() =>
            buildBootstrapRunCreateBody(
                resolveBootstrapTriggerInput(args, {}),
                sample,
            ),
        ).toThrow(/HTTP 429.*--image-source-field/);
    });
    it("requires a sample inside the scope only when OpenSea attachment is explicitly requested", async () => {
        const fetcher = vi.fn(async () =>
            json({ token: "csrf" }),
        ) as typeof fetch;
        await expect(
            triggerBootstrapViaApi(
                { ...manual(), openseaSlug: "project", sampleTokenId: "2000" },
                fetcher,
            ),
        ).rejects.toThrow("inside the selected scope");
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each([true, false])(
        "verifies exact OpenSea association before attachment: %s",
        async (found) => {
            const input = {
                ...manual(),
                openseaSlug: "project",
                sampleTokenId: "42",
            };
            const fetcher = vi.fn(async (url: string | URL | Request) => {
                const parsed = new URL(String(url));
                if (parsed.pathname === API_CSRF_ROUTE_PATH)
                    return json({ token: "csrf" });
                if (parsed.pathname.endsWith("/opensea-slug-probe")) {
                    expect(parsed.searchParams.get("sample_token_id")).toBe(
                        "42",
                    );
                    return json({
                        address: ADDRESS,
                        requestedSlug: "project",
                        status: found
                            ? OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found
                            : OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Missing,
                        slug: found ? "project" : null,
                        reason: null,
                    });
                }
                return json(created);
            }) as typeof fetch;
            if (found)
                expect(
                    (await triggerBootstrapViaApi(input, fetcher)).requestBody
                        .openseaSlug,
                ).toBe("project");
            else
                await expect(
                    triggerBootstrapViaApi(input, fetcher),
                ).rejects.toThrow("OpenSea slug verification failed");
            expect(fetcher).toHaveBeenCalledTimes(found ? 3 : 2);
        },
    );
});
