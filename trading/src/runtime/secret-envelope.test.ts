import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    parseSecretEnvelope,
    SECRET_ENVELOPE_HEADER_LENGTH,
    SECRET_ENVELOPE_MAGIC,
    SECRET_ENVELOPE_VERSION,
} from "./secret-envelope.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, "fixtures", "secret-envelope-v3.json");

type TradingSecretEnvelopeFixture = {
    walletId: string;
    address: string;
    botKind: "bidding" | "sniping";
    chainId: number;
    biddingMandate: {
        chainId: number;
        startPolicy: {
            wethAllowanceCapWei: string;
        };
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
        expect(
            envelope.metadata.biddingMandate?.startPolicy.wethAllowanceCapWei,
        ).toBe(BigInt(fixture.biddingMandate.startPolicy.wethAllowanceCapWei));
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

    it("rejects a v2 frame without compatibility fallback", () => {
        const fixture = loadFixture();
        const buffer = Buffer.from(fixture.payloadHex, "hex");
        buffer[SECRET_ENVELOPE_MAGIC.length] = SECRET_ENVELOPE_VERSION - 1;

        expect(() => parseSecretEnvelope(buffer)).toThrow(
            "version is unsupported: 2",
        );
    });

    it("rejects a bidding envelope without start policy", () => {
        const fixture = loadFixture();
        const metadata = {
            walletId: fixture.walletId,
            address: fixture.address,
            botKind: fixture.botKind,
            chainId: fixture.chainId,
            biddingMandate: {
                chainId: fixture.biddingMandate.chainId,
                collections: fixture.biddingMandate.collections,
            },
        };
        const metadataBytes = Buffer.from(JSON.stringify(metadata));
        const privateKeyBytes = Buffer.from(fixture.privateKeyHex, "hex");
        const frame = Buffer.alloc(
            SECRET_ENVELOPE_HEADER_LENGTH +
                metadataBytes.length +
                privateKeyBytes.length,
        );
        SECRET_ENVELOPE_MAGIC.copy(frame);
        frame.writeUInt8(SECRET_ENVELOPE_VERSION, SECRET_ENVELOPE_MAGIC.length);
        frame.writeUInt32BE(
            metadataBytes.length,
            SECRET_ENVELOPE_MAGIC.length + 1,
        );
        metadataBytes.copy(frame, SECRET_ENVELOPE_HEADER_LENGTH);
        privateKeyBytes.copy(
            frame,
            SECRET_ENVELOPE_HEADER_LENGTH + metadataBytes.length,
        );

        expect(() => parseSecretEnvelope(frame)).toThrow("start policy");
    });
});
