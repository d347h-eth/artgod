import { describe, expect, it } from "vitest";
import {
    BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE_ENV_KEY,
    BLOCK_EXPLORER_ADDRESS_PLACEHOLDER,
    BLOCK_EXPLORER_BASE_URL_ENV_KEY,
    BLOCK_EXPLORER_BLOCK_NUMBER_PLACEHOLDER,
    BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE_ENV_KEY,
    BLOCK_EXPLORER_TX_HASH_PLACEHOLDER,
    BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY,
    buildBlockExplorerAddressUrl,
    buildBlockExplorerBlockUrl,
    buildBlockExplorerTransactionUrl,
    getDefaultBlockExplorerBaseUrl,
    getDefaultBlockExplorerTransactionPathTemplate,
    parseBlockExplorerBaseUrl,
    parseBlockExplorerConfig,
    parseBlockExplorerTransactionPathTemplate,
} from "./block-explorer.js";

const TEST_TX_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_ADDRESS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("block explorer config", () => {
    it("defaults to the manifest block explorer config", () => {
        expect(parseBlockExplorerConfig({})).toEqual({
            baseUrl: getDefaultBlockExplorerBaseUrl(),
            transactionPathTemplate:
                getDefaultBlockExplorerTransactionPathTemplate(),
            addressPathTemplate: `/address/${BLOCK_EXPLORER_ADDRESS_PLACEHOLDER}`,
            blockPathTemplate: `/block/${BLOCK_EXPLORER_BLOCK_NUMBER_PLACEHOLDER}`,
        });
    });

    it("builds transaction, address, and block explorer URLs", () => {
        const config = parseBlockExplorerConfig({
            [BLOCK_EXPLORER_BASE_URL_ENV_KEY]: "https://explorer.example",
            [BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY]: `/transaction/${BLOCK_EXPLORER_TX_HASH_PLACEHOLDER}`,
            [BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE_ENV_KEY]: `/account/${BLOCK_EXPLORER_ADDRESS_PLACEHOLDER}`,
            [BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE_ENV_KEY]: `/height/${BLOCK_EXPLORER_BLOCK_NUMBER_PLACEHOLDER}`,
        });

        expect(
            buildBlockExplorerTransactionUrl({
                config,
                txHash: TEST_TX_HASH,
            }),
        ).toBe(`https://explorer.example/transaction/${TEST_TX_HASH}`);
        expect(
            buildBlockExplorerAddressUrl({
                config,
                address: TEST_ADDRESS,
            }),
        ).toBe(`https://explorer.example/account/${TEST_ADDRESS}`);
        expect(
            buildBlockExplorerBlockUrl({
                config,
                blockNumber: 22_000_000,
            }),
        ).toBe("https://explorer.example/height/22000000");
    });

    it("supports query lookup templates", () => {
        const config = parseBlockExplorerConfig({
            [BLOCK_EXPLORER_BASE_URL_ENV_KEY]: "https://explorer.example",
            [BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY]: `?tx=${BLOCK_EXPLORER_TX_HASH_PLACEHOLDER}`,
        });

        expect(
            buildBlockExplorerTransactionUrl({
                config,
                txHash: TEST_TX_HASH,
            }),
        ).toBe(`https://explorer.example/?tx=${TEST_TX_HASH}`);
    });

    it("rejects base URLs with lookup paths", () => {
        expect(() =>
            parseBlockExplorerBaseUrl("https://explorer.example/tx"),
        ).toThrow(
            `${BLOCK_EXPLORER_BASE_URL_ENV_KEY} must be an HTTP(S) origin URL.`,
        );
    });

    it("rejects lookup templates without the required placeholder", () => {
        expect(() => parseBlockExplorerTransactionPathTemplate("/tx/")).toThrow(
            `${BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY} must include ${BLOCK_EXPLORER_TX_HASH_PLACEHOLDER}.`,
        );
    });

    it("rejects absolute lookup templates", () => {
        expect(() =>
            parseBlockExplorerTransactionPathTemplate(
                `https://explorer.example/tx/${BLOCK_EXPLORER_TX_HASH_PLACEHOLDER}`,
            ),
        ).toThrow(
            `${BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY} must start with / or ?.`,
        );
    });
});
