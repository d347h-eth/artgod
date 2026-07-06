import { describe, expect, it } from "vitest";
import {
    buildTransactionExplorerUrl,
    getDefaultTransactionExplorerUrlTemplate,
    parseTransactionExplorerUrlTemplate,
    TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER,
    TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY,
} from "./transaction-explorer.js";

const TEST_TX_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("transaction explorer config", () => {
    it("defaults to the manifest transaction explorer template", () => {
        expect(parseTransactionExplorerUrlTemplate(undefined)).toBe(
            getDefaultTransactionExplorerUrlTemplate(),
        );
    });

    it("builds transaction explorer URLs by replacing the hash placeholder", () => {
        expect(
            buildTransactionExplorerUrl({
                urlTemplate: `https://explorer.example/tx/${TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER}`,
                txHash: TEST_TX_HASH,
            }),
        ).toBe(`https://explorer.example/tx/${TEST_TX_HASH}`);
    });

    it("rejects templates without the transaction hash placeholder", () => {
        expect(() =>
            parseTransactionExplorerUrlTemplate("https://explorer.example/tx/"),
        ).toThrow(
            `${TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY} must include ${TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER}.`,
        );
    });

    it("rejects non-HTTP transaction explorer templates", () => {
        expect(() =>
            parseTransactionExplorerUrlTemplate(
                `ipfs://explorer/${TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER}`,
            ),
        ).toThrow(
            `${TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY} must be a valid HTTP(S) URL.`,
        );
    });
});
