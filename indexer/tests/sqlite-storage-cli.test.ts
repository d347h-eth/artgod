import { afterEach, describe, expect, it, vi } from "vitest";
import {
    parseStorageProfileArgs,
    parseStorageVerificationArgs,
} from "../scripts/sqlite-storage-cli.js";

// Literal flags deliberately exercise the operator-facing command-line contract.
const inputs = [
    "--chain-id",
    "8453",
    "--weth-address",
    "0x1111111111111111111111111111111111111111",
];
describe("copy-only storage CLI inputs", () => {
    afterEach(() => vi.unstubAllEnvs());
    it("uses explicit market inputs, regardless of runtime environment", () => {
        vi.stubEnv("WETH_ADDRESS", "bad environment value");
        vi.stubEnv("CHAIN_ID", "1");
        expect(
            parseStorageProfileArgs(["copy", "9", "--copied-db", ...inputs]),
        ).toMatchObject({
            chainId: 8453,
            collectionId: 9,
            wethAddress: inputs[3],
            planOnly: false,
        });
        expect(
            parseStorageVerificationArgs([
                "copy",
                "--mutate-copy",
                ...inputs,
                "--compact",
            ]),
        ).toMatchObject({
            chainId: 8453,
            wethAddress: inputs[3],
            compact: true,
            runtimeRoot: null,
        });
    });
    it("does not fill missing CLI values from the environment", () => {
        vi.stubEnv("WETH_ADDRESS", inputs[3]);
        vi.stubEnv("CHAIN_ID", "8453");
        expect(() =>
            parseStorageProfileArgs(["copy", "9", "--copied-db"]),
        ).toThrow("--chain-id");
        expect(() =>
            parseStorageVerificationArgs([
                "copy",
                "--mutate-copy",
                "--chain-id",
                "8453",
            ]),
        ).toThrow("--weth-address");
    });
    it("rejects invalid identities, flags and missing copy consent", () => {
        expect(() =>
            parseStorageProfileArgs(["copy", "NaN", "--copied-db", ...inputs]),
        ).toThrow("collection-id");
        expect(() => parseStorageProfileArgs(["copy", "9", ...inputs])).toThrow(
            "Usage",
        );
        expect(() => parseStorageVerificationArgs(["copy", ...inputs])).toThrow(
            "Usage",
        );
        expect(() =>
            parseStorageVerificationArgs([
                "copy",
                "--mutate-copy",
                ...inputs,
                "--unexpected",
            ]),
        ).toThrow();
        expect(() =>
            parseStorageProfileArgs([
                "copy",
                "9",
                "--copied-db",
                "--chain-id",
                "0",
                ...inputs.slice(2),
            ]),
        ).toThrow("--chain-id");
        expect(() =>
            parseStorageProfileArgs([
                "copy",
                "9",
                "--copied-db",
                ...inputs.slice(0, 2),
                "--weth-address",
                "invalid",
            ]),
        ).toThrow("--weth-address");
    });
    it("requires a read-only preflight for bundled execution", () => {
        expect(() =>
            parseStorageVerificationArgs([
                "copy",
                "--mutate-copy",
                ...inputs,
                "--runtime-root",
                "runtime",
            ]),
        ).toThrow("--skip-read-baseline");
        expect(
            parseStorageVerificationArgs([
                "copy",
                "--mutate-copy",
                ...inputs,
                "--runtime-root",
                "runtime",
                "--skip-read-baseline",
            ]),
        ).toMatchObject({
            skipReadBaseline: true,
        });
        expect(() =>
            parseStorageVerificationArgs([
                "copy",
                "--mutate-copy",
                ...inputs,
                "--runtime-root",
            ]),
        ).toThrow();
    });
});
