import { describe, expect, it } from "vitest";
import {
    SECRET_ENVELOPE_MAGIC,
    SECRET_ENVELOPE_VERSION,
    parseSecretEnvelope,
} from "./secret-envelope.js";

describe("parseSecretEnvelope", () => {
    it("parses a valid binary envelope", () => {
        const metadata = Buffer.from(
            JSON.stringify({
                walletId: "wallet-1",
                address: "0x1111111111111111111111111111111111111111",
                botKind: "bidding",
                chainId: 1,
            }),
            "utf8",
        );
        const privateKey = Buffer.alloc(32, 7);
        const buffer = Buffer.alloc(
            SECRET_ENVELOPE_MAGIC.length +
                1 +
                4 +
                metadata.length +
                privateKey.length,
        );
        let offset = 0;
        SECRET_ENVELOPE_MAGIC.copy(buffer, offset);
        offset += SECRET_ENVELOPE_MAGIC.length;
        buffer.writeUInt8(SECRET_ENVELOPE_VERSION, offset);
        offset += 1;
        buffer.writeUInt32BE(metadata.length, offset);
        offset += 4;
        metadata.copy(buffer, offset);
        offset += metadata.length;
        privateKey.copy(buffer, offset);

        const envelope = parseSecretEnvelope(buffer);
        expect(envelope.metadata.botKind).toBe("bidding");
        expect(envelope.metadata.walletId).toBe("wallet-1");
        expect(envelope.privateKeyBytes).toHaveLength(32);
        expect(envelope.privateKeyBytes[0]).toBe(7);
    });
});
