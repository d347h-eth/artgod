import { TRADING_BOT_KIND } from "@artgod/shared/types";
import { verifyTypedData } from "viem";
import { describe, expect, it } from "vitest";
import { toErrorLogFields } from "../utils/bidding-log.js";
import { SECRET_KEY_LENGTH_BYTES } from "./secret-envelope.js";
import { createSecretEnvelopeTestFrame } from "./secret-envelope-test-fixture.js";
import { consumeTradingSigningAuthority } from "./trading-signing-authority.js";

describe("consumeTradingSigningAuthority", () => {
    it("wipes the complete frame and key alias before the returned signer is used", async () => {
        const fixture = createSecretEnvelopeTestFrame();
        const keyAlias = fixture.frame.subarray(-SECRET_KEY_LENGTH_BYTES);

        const authority = consumeTradingSigningAuthority(
            fixture.frame,
            TRADING_BOT_KIND.Bidding,
        );

        expectEveryByteZero(fixture.frame);
        expectEveryByteZero(keyAlias);

        const typedData = {
            domain: {
                name: "ArtGod signing authority test",
                version: "1",
                chainId: 1,
                verifyingContract:
                    "0x0000000000000000000000000000000000000001" as const,
            },
            types: {
                Proof: [{ name: "nonce", type: "uint256" }],
            },
            primaryType: "Proof" as const,
            message: { nonce: 1n },
        };
        const signature =
            await authority.signingAccount.signTypedData(typedData);
        await expect(
            verifyTypedData({
                ...typedData,
                address: authority.signingAccount.address,
                signature,
            }),
        ).resolves.toBe(true);
    });

    it("returns only non-secret metadata and the signer capability", () => {
        const fixture = createSecretEnvelopeTestFrame();

        const authority = consumeTradingSigningAuthority(
            fixture.frame,
            TRADING_BOT_KIND.Bidding,
        );
        const serialized = JSON.stringify(authority);

        expect(Object.keys(authority).sort()).toEqual([
            "metadata",
            "signingAccount",
        ]);
        expect(authority).not.toHaveProperty("privateKeyHex");
        expect(authority).not.toHaveProperty("privateKeyBytes");
        expect(authority.signingAccount).not.toHaveProperty("privateKey");
        expect(authority.signingAccount).not.toHaveProperty("privateKeyHex");
        expect(authority.signingAccount).not.toHaveProperty("privateKeyBytes");
        expect(serialized).not.toContain(fixture.privateKeyHex);
        expect(serialized).not.toContain(`0x${fixture.privateKeyHex}`);
    });

    it("wipes on a bot-kind mismatch", () => {
        const fixture = createSecretEnvelopeTestFrame();

        expect(() =>
            consumeTradingSigningAuthority(
                fixture.frame,
                TRADING_BOT_KIND.Sniping,
            ),
        ).toThrow("bot kind mismatch");

        expectEveryByteZero(fixture.frame);
    });

    it("wipes on an address mismatch", () => {
        const fixture = createSecretEnvelopeTestFrame({
            address: "0x1111111111111111111111111111111111111111",
        });

        expect(() =>
            consumeTradingSigningAuthority(
                fixture.frame,
                TRADING_BOT_KIND.Bidding,
            ),
        ).toThrow("Derived address mismatch");

        expectEveryByteZero(fixture.frame);
    });

    it("wipes on a malformed address", () => {
        const fixture = createSecretEnvelopeTestFrame({
            address: "not-an-address",
        });

        expect(() =>
            consumeTradingSigningAuthority(
                fixture.frame,
                TRADING_BOT_KIND.Bidding,
            ),
        ).toThrow("wallet address is invalid");

        expectEveryByteZero(fixture.frame);
    });

    it("wipes on an invalid private key and exposes only a sanitized error", () => {
        const fixture = createSecretEnvelopeTestFrame({
            privateKeyBytes: Buffer.alloc(SECRET_KEY_LENGTH_BYTES),
        });

        let thrown: unknown;
        try {
            consumeTradingSigningAuthority(
                fixture.frame,
                TRADING_BOT_KIND.Bidding,
            );
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toEqual(
            new Error("Secret envelope private key is invalid"),
        );
        expectEveryByteZero(fixture.frame);
        expect(JSON.stringify(toErrorLogFields(thrown))).not.toContain(
            fixture.privateKeyHex,
        );
    });

    it("wipes when envelope parsing fails", () => {
        const fixture = createSecretEnvelopeTestFrame();
        fixture.frame[0] ^= 0xff;

        expect(() =>
            consumeTradingSigningAuthority(
                fixture.frame,
                TRADING_BOT_KIND.Bidding,
            ),
        ).toThrow("magic");

        expectEveryByteZero(fixture.frame);
    });

    it("wipes when the current bidding mandate is invalid", () => {
        const fixture = createSecretEnvelopeTestFrame({
            biddingMandate: null,
        });

        expect(() =>
            consumeTradingSigningAuthority(
                fixture.frame,
                TRADING_BOT_KIND.Bidding,
            ),
        ).toThrow("mandate is missing");

        expectEveryByteZero(fixture.frame);
    });
});

function expectEveryByteZero(buffer: Buffer): void {
    expect(buffer.every((byte) => byte === 0)).toBe(true);
}
