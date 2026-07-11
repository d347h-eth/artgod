import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSecretEnvelope } from "./secret-envelope.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, "fixtures", "secret-envelope-v2.json");

type TradingSecretEnvelopeFixture = {
    walletId: string;
    address: string;
    botKind: "bidding" | "sniping";
    chainId: number;
    biddingMandate: {
        chainId: number;
        collections: Array<{ collectionId: number }>;
    };
    privateKeyHex: string;
    payloadHex: string;
};

function loadFixture(): TradingSecretEnvelopeFixture {
    return JSON.parse(
        readFileSync(fixturePath, "utf8"),
    ) as TradingSecretEnvelopeFixture;
}

describe("parseSecretEnvelope", () => {
    it("parses the shared golden envelope fixture", () => {
        const fixture = loadFixture();
        const buffer = Buffer.from(fixture.payloadHex, "hex");

        const envelope = parseSecretEnvelope(buffer);
        expect(envelope.metadata.botKind).toBe(fixture.botKind);
        expect(envelope.metadata.walletId).toBe(fixture.walletId);
        expect(envelope.metadata.address).toBe(fixture.address);
        expect(envelope.metadata.chainId).toBe(fixture.chainId);
        expect(envelope.metadata.biddingMandate?.chainId).toBe(
            fixture.biddingMandate.chainId,
        );
        expect(envelope.privateKeyBytes).toHaveLength(32);
        expect(envelope.privateKeyBytes.toString("hex")).toBe(
            fixture.privateKeyHex,
        );
    });

    it("rejects a truncated envelope", () => {
        const fixture = loadFixture();
        const truncated = Buffer.from(fixture.payloadHex.slice(0, -2), "hex");

        expect(() => parseSecretEnvelope(truncated)).toThrow(
            "length is invalid",
        );
    });

    it("rejects an envelope with invalid magic bytes", () => {
        const fixture = loadFixture();
        const buffer = Buffer.from(fixture.payloadHex, "hex");
        buffer[0] = 0x00;

        expect(() => parseSecretEnvelope(buffer)).toThrow("magic");
    });
});
