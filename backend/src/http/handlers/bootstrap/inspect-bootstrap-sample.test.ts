import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BOOTSTRAP_API_ROUTE_TEMPLATE,
    buildInspectBootstrapSamplePath,
} from "@artgod/shared/http/bootstrap-routes";
import { BOOTSTRAP_ENUMERATION_MODE as Mode } from "@artgod/shared/bootstrap/pipeline";
import { EVM_TOKEN_ID_MAX } from "@artgod/shared/evm/token-id";
import {
    BOOTSTRAP_TEST_ADDRESS as ADDRESS,
    BOOTSTRAP_TEST_CHAIN as CHAIN,
    BOOTSTRAP_TEST_OBSERVATION as OBSERVATION,
    bootstrapTestSample,
} from "@artgod/shared/testing/bootstrap-probe";
import { InspectBootstrapSampleUseCase } from "../../../application/use-cases/bootstrap/inspect-bootstrap-sample.js";
import { registerApiErrorHandlers } from "../../common/error-handlers.js";
import { InspectBootstrapSampleHttpAdapter } from "./inspect-bootstrap-sample.js";

describe("sample inspection HTTP mapping", () => {
    const apps: ReturnType<typeof Fastify>[] = [];
    afterEach(async () => {
        await Promise.all(apps.splice(0).map((app) => app.close()));
    });
    function fixture() {
        const app = Fastify({ logger: false });
        apps.push(app);
        registerApiErrorHandlers(app);
        const checkOwnership = vi.fn(
            async ({ tokenId }: { tokenId: string }) => ({
                tokenId,
                exists: true,
                error: null,
            }),
        );
        const inspect = new InspectBootstrapSampleUseCase(
            1,
            { resolveChainRef: () => CHAIN },
            {
                observation: async () => OBSERVATION,
                verifyObservation: async () => {},
                checkOwnership,
                readMetadata: async () => ({
                    ...bootstrapTestSample().sample,
                    tokenUriPayload: null,
                    tokenUriPayloadError:
                        "Metadata download failed (HTTP 429). Press inspect to retry.",
                }),
            },
            {
                resolveExtensionKey: () => null,
                resolveImageCachePolicyConfig: () => null,
            },
            "https://ipfs.io",
        );
        app.post(
            BOOTSTRAP_API_ROUTE_TEMPLATE.InspectSample,
            new InspectBootstrapSampleHttpAdapter(inspect).handle,
        );
        return { app, checkOwnership };
    }

    it("serializes canonical uint256 IDs and partial failures without losing owned sample or selected scope", async () => {
        const { app } = fixture();
        const id = EVM_TOKEN_ID_MAX.toString();
        const response = await app.inject({
            method: "POST",
            url: buildInspectBootstrapSamplePath(CHAIN.slug),
            payload: {
                address: ADDRESS,
                requestedTokenId: " " + id + " ",
                observation: OBSERVATION,
                scope: { mode: Mode.ManualTokenIds, tokenIds: [id, id] },
            },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            address: ADDRESS,
            requestedTokenId: id,
            observation: OBSERVATION,
            scope: { mode: Mode.ManualTokenIds, tokenIds: [id] },
            sample: {
                tokenId: id,
                ownership: { exists: true },
                tokenUriPayloadError: expect.stringContaining("HTTP 429"),
            },
        });
        expect(response.json()).not.toHaveProperty("firstToken");
    });

    it.each([{}, { address: 42 }])(
        "rejects malformed HTTP input before domain calls",
        async (payload) => {
            const { app, checkOwnership } = fixture();
            const response = await app.inject({
                method: "POST",
                url: buildInspectBootstrapSamplePath(CHAIN.slug),
                payload,
            });
            expect(response.statusCode).toBe(400);
            expect(checkOwnership).not.toHaveBeenCalled();
        },
    );

    it.each([
        { requestedTokenId: "-1" },
        { requestedTokenId: 1 },
        { requestedTokenId: (EVM_TOKEN_ID_MAX + 1n).toString() },
        { scope: { mode: Mode.ManualRange, startTokenId: "1", tokenCount: 0 } },
        { scope: { mode: Mode.ManualTokenIds, tokenIds: ["bad"] } },
    ])(
        "maps invalid domain input to validation feedback before RPC: %j",
        async (invalid) => {
            const { app, checkOwnership } = fixture();
            const response = await app.inject({
                method: "POST",
                url: buildInspectBootstrapSamplePath(CHAIN.slug),
                payload: { address: ADDRESS, ...invalid },
            });
            expect(response.statusCode).toBe(422);
            expect(response.json().error).toBe("validation_error");
            expect(checkOwnership).not.toHaveBeenCalled();
        },
    );
});
