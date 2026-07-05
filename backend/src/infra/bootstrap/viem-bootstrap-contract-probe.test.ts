import { describe, expect, it } from "vitest";
import { BootstrapValidationError } from "../../application/use-cases/bootstrap/types.js";
import {
    NON_CONTRACT_ADDRESS_PROBE_ERROR,
    ViemBootstrapContractProbe,
} from "./viem-bootstrap-contract-probe.js";

const TEST_EMPTY_ADDRESS = "0xae59ef400dec8fc951f2ec6de2af1b0500ef62eb";
const TEST_CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";
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
            await probe.probeErc721Contract({ address: TEST_EMPTY_ADDRESS });
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
                image: TEST_ONE_PIXEL_PNG,
            }),
        )}`;
        const probe = new ViemBootstrapContractProbe({
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

        const result = await probe.probeErc721Contract({
            address: TEST_CONTRACT_ADDRESS,
        });

        expect(result.firstToken.imageBytesSource).toBe("data_uri");
        expect(result.firstToken.imageContentType).toBe("image/png");
        expect(result.firstToken.imageBytes).toBeGreaterThan(0);
        expect(result.firstToken.imageWidth).toBe(1);
        expect(result.firstToken.imageHeight).toBe(1);
    });
});
