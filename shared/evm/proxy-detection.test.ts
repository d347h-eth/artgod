import { describe, expect, it } from "vitest";
import { detectEvmProxy, EVM_PROXY_KIND } from "./proxy-detection.js";

const TEST_EIP1167_PROXY_BYTECODE =
    "0x363d3d373d3d3d363d73a968ab882ad106b14c3d2c60686315a7c4d0d2f45af43d82803e903d91602b57fd5bf3";

describe("detectEvmProxy", () => {
    it("detects EIP-1167 minimal proxy runtime bytecode", () => {
        expect(detectEvmProxy(TEST_EIP1167_PROXY_BYTECODE)).toEqual({
            kind: EVM_PROXY_KIND.Eip1167Minimal,
            implementationAddress:
                "0xa968ab882ad106b14c3d2c60686315a7c4d0d2f4",
        });
    });

    it("ignores non-proxy bytecode and malformed values", () => {
        expect(detectEvmProxy("0x6080604052")).toBeNull();
        expect(detectEvmProxy("0xnot-hex")).toBeNull();
        expect(detectEvmProxy(null)).toBeNull();
    });
});
