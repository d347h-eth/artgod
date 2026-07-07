import { describe, expect, it } from "vitest";
import {
    detectErc1967BeaconProxy,
    detectErc1967ImplementationProxy,
    detectEvmProxy,
    EVM_PROXY_CONFIDENCE,
    EVM_PROXY_KIND,
    readErc1967BeaconAddress,
} from "./proxy-detection.js";

const TEST_EIP1167_PROXY_BYTECODE =
    "0x363d3d373d3d3d363d73a968ab882ad106b14c3d2c60686315a7c4d0d2f45af43d82803e903d91602b57fd5bf3";
const TEST_IMPLEMENTATION_ADDRESS =
    "0xa968ab882ad106b14c3d2c60686315a7c4d0d2f4";
const TEST_BEACON_ADDRESS = "0x2222222222222222222222222222222222222222";

describe("detectEvmProxy", () => {
    it("detects EIP-1167 minimal proxy runtime bytecode", () => {
        expect(detectEvmProxy(TEST_EIP1167_PROXY_BYTECODE)).toEqual({
            kind: EVM_PROXY_KIND.Eip1167Minimal,
            confidence: EVM_PROXY_CONFIDENCE.Deterministic,
            implementationAddress: TEST_IMPLEMENTATION_ADDRESS,
            beaconAddress: null,
        });
    });

    it("ignores non-proxy bytecode and malformed values", () => {
        expect(detectEvmProxy("0x6080604052")).toBeNull();
        expect(detectEvmProxy("0xnot-hex")).toBeNull();
        expect(detectEvmProxy(null)).toBeNull();
    });
});

describe("detectErc1967ImplementationProxy", () => {
    it("detects implementation-slot proxies from a storage word", () => {
        expect(
            detectErc1967ImplementationProxy(
                storageWord(TEST_IMPLEMENTATION_ADDRESS),
            ),
        ).toEqual({
            kind: EVM_PROXY_KIND.Erc1967Implementation,
            confidence: EVM_PROXY_CONFIDENCE.Deterministic,
            implementationAddress: TEST_IMPLEMENTATION_ADDRESS,
            beaconAddress: null,
        });
    });

    it("ignores empty and malformed implementation slots", () => {
        expect(detectErc1967ImplementationProxy(storageWord(null))).toBeNull();
        expect(detectErc1967ImplementationProxy("0x01")).toBeNull();
        expect(detectErc1967ImplementationProxy(null)).toBeNull();
    });
});

describe("detectErc1967BeaconProxy", () => {
    it("detects beacon proxies from beacon and implementation addresses", () => {
        const beaconAddress = readErc1967BeaconAddress(
            storageWord(TEST_BEACON_ADDRESS),
        );
        expect(beaconAddress).toBe(TEST_BEACON_ADDRESS);

        expect(
            detectErc1967BeaconProxy({
                beaconAddress,
                implementationAddress: TEST_IMPLEMENTATION_ADDRESS,
            }),
        ).toEqual({
            kind: EVM_PROXY_KIND.Erc1967Beacon,
            confidence: EVM_PROXY_CONFIDENCE.Deterministic,
            implementationAddress: TEST_IMPLEMENTATION_ADDRESS,
            beaconAddress: TEST_BEACON_ADDRESS,
        });
    });

    it("ignores empty and malformed beacon inputs", () => {
        expect(readErc1967BeaconAddress(storageWord(null))).toBeNull();
        expect(
            detectErc1967BeaconProxy({
                beaconAddress: null,
                implementationAddress: TEST_IMPLEMENTATION_ADDRESS,
            }),
        ).toBeNull();
        expect(
            detectErc1967BeaconProxy({
                beaconAddress: TEST_BEACON_ADDRESS,
                implementationAddress: "not an address",
            }),
        ).toBeNull();
    });
});

function storageWord(address: string | null): `0x${string}` {
    if (!address) return `0x${"0".repeat(64)}`;
    return `0x${"0".repeat(24)}${address.slice(2)}`;
}
