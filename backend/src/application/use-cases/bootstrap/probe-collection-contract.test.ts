import { describe, expect, it, vi } from "vitest";
import {
    BOOTSTRAP_TEST_CHAIN as CHAIN,
    BOOTSTRAP_TEST_ADDRESS as ADDRESS,
    BOOTSTRAP_TEST_OBSERVATION as OBSERVATION,
    bootstrapTestContract,
    bootstrapTestSample,
    BOOTSTRAP_CONTRACT_CASES,
    BOOTSTRAP_TEST_PROJECT_SCOPE,
} from "@artgod/shared/testing/bootstrap-probe";
import { BOOTSTRAP_ENUMERATION_MODE as Mode } from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_SAMPLE_SOURCE as Source } from "@artgod/shared/bootstrap/probe";
import {
    BOOTSTRAP_OUTPUT_STEP as Step,
    BOOTSTRAP_OUTPUT_STATUS as Status,
} from "@artgod/shared/bootstrap/operation-output";
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND as SourceKind } from "@artgod/shared/types";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND as ScopeKind } from "@artgod/shared/extensions";
import { defaultImageCachePolicyConfig } from "@artgod/shared/media/token-image-cache";
import { ProbeCollectionContractUseCase } from "./probe-collection-contract.js";
import {
    InspectBootstrapSampleUseCase,
    type BootstrapSampleInspectionPort,
} from "./inspect-bootstrap-sample.js";

const resolver = { resolveChainRef: () => CHAIN };
function fixture(existing: (id: string) => boolean | null = () => true) {
    const metadata = bootstrapTestSample().sample;
    const port: BootstrapSampleInspectionPort = {
        observation: vi.fn(async () => OBSERVATION),
        verifyObservation: vi.fn(async () => {}),
        checkOwnership: vi.fn(async ({ tokenId }) => ({
            tokenId,
            exists: existing(tokenId),
            error: existing(tokenId) === true ? null : "ownership failed",
        })),
        readMetadata: vi.fn(async () => metadata),
        readProjectScope: vi.fn(async () => null),
    };
    const extensions = {
        resolveExtensionKey: vi.fn((): string | null => null),
        resolveImageCachePolicyConfig: vi.fn(() =>
            defaultImageCachePolicyConfig(),
        ),
    };
    return {
        port,
        extensions,
        inspector: new InspectBootstrapSampleUseCase(
            1,
            resolver,
            port,
            extensions,
            "https://ipfs.io",
        ),
    };
}
describe("bootstrap probe use cases", () => {
    it("retains project facts through metadata failure without replacing the entered scope", async () => {
        const { inspector, port } = fixture();
        vi.mocked(port.readProjectScope).mockResolvedValue(
            BOOTSTRAP_TEST_PROJECT_SCOPE,
        );
        vi.mocked(port.readMetadata).mockResolvedValue({
            ...bootstrapTestSample().sample,
            tokenUriPayload: null,
            tokenUriPayloadError: "HTTP 429",
        });
        const scope = {
            mode: Mode.ManualRange,
            startTokenId: "1",
            tokenCount: 999,
        } as const;
        const result = await inspector.inspect({
            chainRef: CHAIN.slug,
            address: ADDRESS,
            requestedTokenId: "163000485",
            scope,
        });
        expect(result.projectScope).toEqual(BOOTSTRAP_TEST_PROJECT_SCOPE);
        expect(result.sample.tokenUriPayloadError).toBe("HTTP 429");
        expect(result.scope).toEqual(scope);
        expect(port.readProjectScope).toHaveBeenCalledWith(
            {
                chainId: CHAIN.publicChainId,
                address: ADDRESS,
                tokenId: "163000485",
                observation: OBSERVATION,
            },
            undefined,
        );
        expect(port.verifyObservation).toHaveBeenCalledWith(
            OBSERVATION,
            undefined,
        );
    });
    it.each([false, null])(
        "never looks up a project when sample ownership is %s",
        async (exists) => {
            const { inspector, port } = fixture(() => exists);
            const result = await inspector.inspect({
                chainRef: CHAIN.slug,
                address: ADDRESS,
                requestedTokenId: "163000485",
            });
            expect(result.projectScope).toBeNull();
            expect(port.readProjectScope).not.toHaveBeenCalled();
        },
    );
    it("does not return project suggestions when the pinned observation fails verification", async () => {
        const { inspector, port } = fixture();
        vi.mocked(port.readProjectScope).mockResolvedValue(
            BOOTSTRAP_TEST_PROJECT_SCOPE,
        );
        vi.mocked(port.verifyObservation).mockRejectedValue(
            new Error("block changed"),
        );
        await expect(
            inspector.inspect({
                chainRef: CHAIN.slug,
                address: ADDRESS,
                requestedTokenId: "163000485",
            }),
        ).rejects.toThrow("block changed");
    });
    it("reports the selected existing sample before waiting for metadata", async () => {
        const { inspector, port } = fixture((id) => id === "7");
        const report = vi.fn();
        vi.mocked(port.readMetadata).mockImplementation(async () => {
            expect(report).toHaveBeenCalledWith(
                expect.objectContaining({
                    step: Step.Sample,
                    status: Status.Succeeded,
                    tokenId: "7",
                }),
            );
            return bootstrapTestSample().sample;
        });
        const result = await inspector.inspect(
            {
                chainRef: CHAIN.slug,
                address: ADDRESS,
                discoveredTokenId: "100",
                scope: { mode: Mode.ManualTokenIds, tokenIds: ["5", "7"] },
            },
            report,
        );
        expect(result.sample.tokenId).toBe("7");
        expect(
            report.mock.calls.filter(
                ([output]) => output.tokenId !== undefined,
            ),
        ).toEqual([[expect.objectContaining({ tokenId: "7" })]]);
    });
    it("passes the public chain ID to registry recognition, independently of the local chain record ID", async () => {
        const discoverContract = vi.fn(async () => bootstrapTestContract());
        const chain = { ...CHAIN, id: 3, publicChainId: 10 };
        const useCase = new ProbeCollectionContractUseCase(
            chain.id,
            { resolveChainRef: () => chain },
            { discoverContract },
        );
        await useCase.probe({
            chainRef: CHAIN.slug,
            address: ADDRESS,
            standard: "erc721",
        });
        expect(discoverContract).toHaveBeenCalledWith(
            ADDRESS,
            chain.publicChainId,
            undefined,
        );
    });
    it("discovers facts without sample or scope recommendations", async () => {
        const discoverContract = vi.fn(async () => bootstrapTestContract());
        const useCase = new ProbeCollectionContractUseCase(1, resolver, {
            discoverContract,
        });
        const result = await useCase.probe({
            chainRef: CHAIN.slug,
            address: " " + ADDRESS.toUpperCase().replace("0X", "0x") + " ",
            standard: "erc721",
        });
        expect(discoverContract).toHaveBeenCalledWith(
            ADDRESS,
            CHAIN.publicChainId,
            undefined,
        );
        expect(result).not.toHaveProperty("firstToken");
        expect(result).not.toHaveProperty("suggestedInput");
        await expect(
            useCase.probe({
                chainRef: CHAIN.slug,
                address: "bad",
                standard: "erc721",
            }),
        ).rejects.toThrow("Invalid address");
        await expect(
            useCase.probe({
                chainRef: CHAIN.slug,
                address: ADDRESS,
                standard: "erc1155" as "erc721",
            }),
        ).rejects.toThrow("Only erc721");
    });
    it.each([true, false, null])(
        "inspects exactly the explicit override for ownership %s",
        async (exists) => {
            const { inspector, port } = fixture(() => exists);
            const result = await inspector.inspect({
                chainRef: CHAIN.slug,
                address: ADDRESS,
                requestedTokenId: " 00042 ",
                discoveredTokenId: "0",
            });
            expect(result.requestedTokenId).toBe("42");
            expect(result.sample.tokenId).toBe("42");
            expect(result.sample.source).toBe(Source.Requested);
            expect(port.checkOwnership).toHaveBeenCalledTimes(1);
            expect(port.readMetadata).toHaveBeenCalledTimes(
                exists === true ? 1 : 0,
            );
            expect(result.sample.ownership?.exists).toBe(exists);
        },
    );
    it.each(BOOTSTRAP_CONTRACT_CASES)(
        "keeps $name scope through metadata failure and retries",
        async (c) => {
            const { inspector, port, extensions } = fixture(
                (id) => id === c.sample,
            );
            vi.mocked(port.readMetadata).mockResolvedValue({
                ...bootstrapTestSample().sample,
                tokenUriPayload: null,
                tokenUriPayloadError: "HTTP 429",
            });
            const scope = {
                mode: Mode.ManualRange,
                startTokenId: c.start,
                tokenCount: c.count,
            } as const;
            const result = await inspector.inspect({
                chainRef: CHAIN.slug,
                address: c.address,
                scope,
                requestedTokenId: c.sample,
                discoveredTokenId: "0",
            });
            expect(result.scope).toEqual(scope);
            expect(result.sample.tokenUriPayloadError).toBe("HTTP 429");
            expect(extensions.resolveExtensionKey).toHaveBeenCalledWith({
                chainId: 1,
                contractAddress: c.address,
                scope: {
                    kind: ScopeKind.TokenRange,
                    startTokenId: c.start,
                    totalSupply: c.count,
                },
            });
            expect(result.sample.ownership?.exists).toBe(true);
        },
    );
    it("prefers a present token from a declared list and retains an outside fallback when none exists", async () => {
        const { inspector, port } = fixture((id) => id === "7" || id === "100");
        const scope = {
            mode: Mode.ManualTokenIds,
            tokenIds: ["5", "7", "9"],
        } as const;
        const first = await inspector.inspect({
            chainRef: CHAIN.slug,
            address: ADDRESS,
            scope: { ...scope, tokenIds: [...scope.tokenIds] },
            discoveredTokenId: "100",
        });
        expect(first.sample.tokenId).toBe("7");
        expect(
            vi.mocked(port.checkOwnership).mock.calls.map(([p]) => p.tokenId),
        ).toEqual(["5", "7"]);
        const outside = await inspector.inspect({
            chainRef: CHAIN.slug,
            address: ADDRESS,
            scope: {
                mode: Mode.ManualRange,
                startTokenId: "1000",
                tokenCount: 1000,
            },
            discoveredTokenId: "100",
        });
        expect(outside.sample.tokenId).toBe("100");
        const none = await fixture(() => false).inspector.inspect({
            chainRef: CHAIN.slug,
            address: ADDRESS,
        });
        expect(none.sample.tokenId).toBeNull();
    });
    it.each(["-1", "1.5", "1e3", "token-42", "0x2", "9".repeat(79)])(
        "rejects malformed sample %s before RPC",
        async (requestedTokenId) => {
            const { inspector, port } = fixture();
            await expect(
                inspector.inspect({
                    chainRef: CHAIN.slug,
                    address: ADDRESS,
                    requestedTokenId,
                }),
            ).rejects.toThrow("decimal sample");
            expect(port.observation).not.toHaveBeenCalled();
        },
    );
    it("rejects invalid scope before RPC and scopes extension suggestions to the entered definition", async () => {
        const { inspector, port, extensions } = fixture();
        await expect(
            inspector.inspect({
                chainRef: CHAIN.slug,
                address: ADDRESS,
                scope: {
                    mode: Mode.ManualRange,
                    startTokenId: "0",
                    tokenCount: 0,
                },
            }),
        ).rejects.toThrow();
        expect(port.observation).not.toHaveBeenCalled();
        extensions.resolveExtensionKey.mockReturnValue("test-extension");
        const result = await inspector.inspect({
            chainRef: CHAIN.slug,
            address: ADDRESS,
            scope: { mode: Mode.Enumerable },
        });
        expect(result.imageCacheSuggestion.selectedSource).toBe(
            SourceKind.Extension,
        );
        expect(result.sample.tokenId).toBeNull();
    });
});
