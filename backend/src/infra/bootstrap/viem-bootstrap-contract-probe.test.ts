import { describe, expect, it } from "vitest";
import { TOKEN_METADATA_ANIMATION_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-animation-source";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import { EVM_PROXY_KIND } from "@artgod/shared/evm/proxy-detection";
import { BootstrapValidationError } from "../../application/use-cases/bootstrap/types.js";
import {
    NON_CONTRACT_ADDRESS_PROBE_ERROR,
    ViemBootstrapContractProbe,
} from "./viem-bootstrap-contract-probe.js";

const TEST_EMPTY_ADDRESS = "0xae59ef400dec8fc951f2ec6de2af1b0500ef62eb";
const TEST_CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";
const TEST_PROXY_ADDRESS = "0xc292e3e1160500cb9832b7e40f5585d66c639503";
const TEST_PROXY_IMPLEMENTATION_ADDRESS =
    "0xa968ab882ad106b14c3d2c60686315a7c4d0d2f4";
const TEST_EIP1167_PROXY_BYTECODE =
    "0x363d3d373d3d3d363d73a968ab882ad106b14c3d2c60686315a7c4d0d2f45af43d82803e903d91602b57fd5bf3";
const TEST_ONE_PIXEL_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("ViemBootstrapContractProbe", () => {
    it("rejects addresses without contract bytecode before ERC165 reads", async () => {
        const calls: string[] = [];
        const probe = new ViemBootstrapContractProbe({
            async getBytecode(address) {
                calls.push("getBytecode");
                expect(address).toBe(TEST_EMPTY_ADDRESS);
                return "0x";
            },
            async readContract() {
                calls.push("readContract");
                throw new Error("readContract should not run");
            },
        });

        let thrown: unknown = null;
        try {
            await probe.probeErc721Contract({
                address: TEST_EMPTY_ADDRESS,
                imageSourceField: null,
                animationSourceField: null,
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(BootstrapValidationError);
        expect(thrown).toMatchObject({
            message: NON_CONTRACT_ADDRESS_PROBE_ERROR,
        });
        expect(calls).toEqual(["getBytecode"]);
    });

    it("reads sample image dimensions during the contract probe", async () => {
        const tokenUri = `data:application/json,${encodeURIComponent(
            JSON.stringify({
                name: "Sample 1",
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image]: TEST_ONE_PIXEL_PNG,
            }),
        )}`;
        const probe = makeEnumerableProbe(tokenUri);

        const result = await probe.probeErc721Contract({
            address: TEST_CONTRACT_ADDRESS,
            imageSourceField: null,
            animationSourceField: null,
        });

        expect(result.firstToken.imageSourceField).toBe(
            TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
        );
        expect(result.firstToken.imageBytesSource).toBe("data_uri");
        expect(result.firstToken.imageContentType).toBe("image/png");
        expect(result.firstToken.imageBytes).toBeGreaterThan(0);
        expect(result.firstToken.imageWidth).toBe(1);
        expect(result.firstToken.imageHeight).toBe(1);
    });

    it("uses generator_url as the sample token animation fallback", async () => {
        const generatorUrl = "https://generator.example/token/1";
        const tokenUri = `data:application/json,${encodeURIComponent(
            JSON.stringify({
                name: "Sample 1",
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image]: TEST_ONE_PIXEL_PNG,
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                    generatorUrl,
            }),
        )}`;
        const probe = makeEnumerableProbe(tokenUri);

        const result = await probe.probeErc721Contract({
            address: TEST_CONTRACT_ADDRESS,
            imageSourceField: null,
            animationSourceField: null,
        });

        expect(result.firstToken.animationSourceField).toBe(
            TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl,
        );
        expect(result.firstToken.animationUrl).toBe(generatorUrl);
    });

    it("uses the requested animation source field when supplied", async () => {
        const generatorUrl = "https://generator.example/token/1";
        const tokenUri = `data:application/json,${encodeURIComponent(
            JSON.stringify({
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl]:
                    "https://example.com/animation.html",
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                    generatorUrl,
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image]: TEST_ONE_PIXEL_PNG,
            }),
        )}`;
        const probe = makeEnumerableProbe(tokenUri);

        const result = await probe.probeErc721Contract({
            address: TEST_CONTRACT_ADDRESS,
            imageSourceField: null,
            animationSourceField:
                TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl,
        });

        expect(result.firstToken.animationSourceField).toBe(
            TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl,
        );
        expect(result.firstToken.animationUrl).toBe(generatorUrl);
    });

    it("does not fall back when the requested animation source field is invalid", async () => {
        const tokenUri = `data:application/json,${encodeURIComponent(
            JSON.stringify({
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl]: "not a uri",
                [TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl]:
                    "https://generator.example/token/1",
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image]: TEST_ONE_PIXEL_PNG,
            }),
        )}`;
        const probe = makeEnumerableProbe(tokenUri);

        const result = await probe.probeErc721Contract({
            address: TEST_CONTRACT_ADDRESS,
            imageSourceField: null,
            animationSourceField:
                TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl,
        });

        expect(result.firstToken.animationSourceField).toBeNull();
        expect(result.firstToken.animationUrl).toBeNull();
    });

    it("selects onchain image_data when canonical image fields are absent", async () => {
        const tokenUri = `data:application/json,${encodeURIComponent(
            JSON.stringify({
                name: "Onchain 1",
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.ImageData]: TEST_ONE_PIXEL_PNG,
            }),
        )}`;
        const probe = makeEnumerableProbe(tokenUri);

        const result = await probe.probeErc721Contract({
            address: TEST_CONTRACT_ADDRESS,
            imageSourceField: null,
            animationSourceField: null,
        });

        expect(result.firstToken.imageSourceField).toBe(
            TOKEN_METADATA_IMAGE_SOURCE_FIELD.ImageData,
        );
        expect(result.firstToken.image).toBe(TEST_ONE_PIXEL_PNG);
        expect(result.firstToken.imageWidth).toBe(1);
        expect(result.firstToken.imageHeight).toBe(1);
    });

    it("uses the requested image source field when supplied", async () => {
        const tokenUri = `data:application/json,${encodeURIComponent(
            JSON.stringify({
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image]:
                    "https://example.com/preview.png",
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData]:
                    TEST_ONE_PIXEL_PNG,
            }),
        )}`;
        const probe = makeEnumerableProbe(tokenUri);

        const result = await probe.probeErc721Contract({
            address: TEST_CONTRACT_ADDRESS,
            imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData,
            animationSourceField: null,
        });

        expect(result.firstToken.imageSourceField).toBe(
            TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData,
        );
        expect(result.firstToken.image).toBe(TEST_ONE_PIXEL_PNG);
    });

    it("detects EIP-1167 minimal proxies while probing through the proxy address", async () => {
        const tokenUri = `data:application/json,${encodeURIComponent(
            JSON.stringify({
                name: "Proxy Sample 0",
                [TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image]: TEST_ONE_PIXEL_PNG,
            }),
        )}`;
        const readAddresses: string[] = [];
        const probe = new ViemBootstrapContractProbe({
            async getBytecode(address) {
                expect(address).toBe(TEST_PROXY_ADDRESS);
                return TEST_EIP1167_PROXY_BYTECODE;
            },
            async readContract<T = unknown>(params: {
                address: string;
                functionName: string;
                args?: readonly unknown[];
            }): Promise<T> {
                readAddresses.push(params.address);
                if (params.functionName === "supportsInterface") {
                    return (params.args?.[0] === "0x80ac58cd") as T;
                }
                if (params.functionName === "name") return "Sketchbook B" as T;
                if (params.functionName === "totalSupply") return 64n as T;
                if (params.functionName === "tokenURI") return tokenUri as T;
                if (params.functionName === "ownerOf") {
                    return "0x2222222222222222222222222222222222222222" as T;
                }
                throw new Error(`unexpected read ${params.functionName}`);
            },
        });

        const result = await probe.probeErc721Contract({
            address: TEST_PROXY_ADDRESS,
            imageSourceField: null,
            animationSourceField: null,
        });

        expect(result.proxy).toEqual({
            kind: EVM_PROXY_KIND.Eip1167Minimal,
            implementationAddress: TEST_PROXY_IMPLEMENTATION_ADDRESS,
        });
        expect(result.contractName).toBe("Sketchbook B");
        expect(result.erc721.supported).toBe(true);
        expect(result.enumerable.supported).toBe(false);
        expect(result.totalSupply.value).toBe("64");
        expect(result.firstToken.tokenId).toBe("0");
        expect(result.firstToken.source).toBe("candidate_token_uri");
        expect(result.firstToken.imageSourceField).toBe(
            TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
        );
        expect(new Set(readAddresses)).toEqual(new Set([TEST_PROXY_ADDRESS]));
    });
});

function makeEnumerableProbe(tokenUri: string): ViemBootstrapContractProbe {
    return new ViemBootstrapContractProbe({
        async getBytecode() {
            return "0x01";
        },
        async readContract<T = unknown>(params: {
            functionName: string;
        }): Promise<T> {
            if (params.functionName === "supportsInterface") return true as T;
            if (params.functionName === "name") return "Sample" as T;
            if (params.functionName === "totalSupply") return 1n as T;
            if (params.functionName === "tokenByIndex") return 1n as T;
            if (params.functionName === "tokenURI") return tokenUri as T;
            throw new Error(`unexpected read ${params.functionName}`);
        },
    });
}
