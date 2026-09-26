import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
    BOOTSTRAP_API_ROUTE_TEMPLATE,
    buildEstimateBootstrapImageCachePath,
} from "@artgod/shared/http/bootstrap-routes";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { HttpFetchRequestTimeoutError } from "@artgod/shared/network/http-fetch-resilience";
import { EstimateBootstrapImageCacheUseCase } from "../../../application/use-cases/bootstrap/estimate-bootstrap-image-cache.js";
import { SharpBootstrapImageCacheEstimateAdapter } from "../../../infra/media/sharp-bootstrap-image-cache-estimate.js";
import { registerApiErrorHandlers } from "../../common/error-handlers.js";
import { EstimateBootstrapImageCacheHttpAdapter } from "./estimate-bootstrap-image-cache.js";
import type { SharpFactoryLoader } from "../../../infra/media/sharp-loader.js";

const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="cyan"/></svg>';
const sourceImageUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const input = {
    sampleTokenId: "1",
    sourceImageUrl,
    sourceImageBytes: null,
    totalSupply: "3333",
    imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
    maxDimension: 64,
};

afterEach(() => vi.unstubAllGlobals());

describe("bootstrap image cache HTTP and native image processing", () => {
    async function estimate(
        body: typeof input,
        sharpLoader?: SharpFactoryLoader,
    ) {
        const app = Fastify({ logger: false });
        registerApiErrorHandlers(app);
        const adapter = new EstimateBootstrapImageCacheHttpAdapter(
            new EstimateBootstrapImageCacheUseCase(
                1,
                {
                    resolveChainRef: () => ({
                        id: 1,
                        publicChainId: 1,
                        type: "evm",
                        slug: "ethereum",
                        name: "Ethereum",
                    }),
                },
                new SharpBootstrapImageCacheEstimateAdapter({
                    sharpLoader,
                    ipfsGatewayOrigin: "https://gateway.example",
                    maxSourceBytes: 1024 * 1024,
                    fetchResilience: {
                        requestTimeoutMs: 1000,
                        retryPolicy: {
                            maxAttempts: 1,
                            baseDelayMs: 0,
                            maxDelayMs: 0,
                        },
                    },
                }),
            ),
        );
        app.post(
            BOOTSTRAP_API_ROUTE_TEMPLATE.EstimateImageCache,
            adapter.handle,
        );
        try {
            const response = await app.inject({
                method: "POST",
                url: buildEstimateBootstrapImageCachePath("ethereum"),
                payload: body,
            });
            return { status: response.statusCode, body: response.json() };
        } finally {
            await app.close();
        }
    }

    it("transforms real inline image bytes and projects the selected collection supply", async () => {
        const result = await estimate(input);
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({
            sampleTokenId: "1",
            sourceWidth: 80,
            sourceHeight: 40,
            width: 64,
            height: 32,
            contentType: "image/webp",
            totalSupply: "3333",
        });
        expect(result.body.sampleCachedBytes).toBeGreaterThan(0);
        expect(result.body.projectedCachedBytes).toBe(
            String(result.body.sampleCachedBytes * 3333),
        );
        expect(result.body.sampleCachedImageDataUrl).toMatch(
            /^data:image\/webp;base64,/,
        );
    });

    it.each([429, 404])(
        "reports an upstream HTTP %i with gateway recovery instead of an internal error",
        async (status) => {
            vi.stubGlobal(
                "fetch",
                vi.fn(
                    async () =>
                        new Response("upstream private detail", { status }),
                ),
            );
            const result = await estimate({
                ...input,
                sourceImageUrl: "ipfs://sample/image.png",
            });
            expect(result.status).toBe(502);
            expect(result.body.message).toContain(
                `Image download failed (HTTP ${status})`,
            );
            expect(result.body.message).toContain(
                "IPFS gateway in Admin config",
            );
            expect(result.body.message).not.toContain(
                "upstream private detail",
            );
        },
    );

    it("keeps image decoding errors actionable without exposing library details", async () => {
        const result = await estimate({
            ...input,
            sourceImageUrl: "data:image/png;base64,bm90LWFuLWltYWdl",
        });
        expect(result.status).toBe(502);
        expect(result.body.message).toContain(
            "could not be decoded or resized",
        );
        expect(result.body.message).toContain("Image cache mode to off");
    });

    it("reports a timed out image request as a download failure", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new HttpFetchRequestTimeoutError(1000)),
        );
        const result = await estimate({
            ...input,
            sourceImageUrl: "https://images.example/1.png",
        });
        expect(result.status).toBe(502);
        expect(result.body.message).toContain("Image download timed out");
        expect(result.body.message).toContain("Press estimate to retry");
    });

    it("distinguishes unavailable image processing from an unreadable sample", async () => {
        const result = await estimate(input, async () => {
            throw new Error("native processor unavailable");
        });
        expect(result.status).toBe(502);
        expect(result.body.message).toContain(
            "Image processing is unavailable",
        );
        expect(result.body.message).toContain("Restart infra");
        expect(result.body.message).not.toContain("could not be decoded");
        expect(result.body.message).not.toContain(
            "native processor unavailable",
        );
    });
});
