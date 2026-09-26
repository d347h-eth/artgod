import { describe, expect, it } from "vitest";
import { compactSignatureToSignature, serializeSignature } from "viem";
import {
    computeSeaportOrderHash,
    recoverSeaportSigner,
} from "../src/application/offchain/seaport-protocol.js";
import { capturedBulkOrder } from "./fixtures/seaport-bulk-order.js";
import { seaportSignatureVectors as vectors } from "./fixtures/seaport-signature-vectors.js";

describe("Seaport bulk-order signatures", () => {
    describe.each(["compact", "standard"] as const)(
        "%s signature",
        (format) => {
            it.each(vectors.cases)(
                "recovers the SDK fixture at height $height, index $index",
                async (vector) => {
                    let signature = vector.signature;
                    if (format === "standard") {
                        signature =
                            serializeSignature(
                                compactSignatureToSignature({
                                    r: `0x${signature.slice(2, 66)}`,
                                    yParityAndS: `0x${signature.slice(66, 130)}`,
                                }),
                            ) + signature.slice(130);
                    }
                    const data = {
                        ...vectors.seaportData,
                        salt: vector.salt,
                        signature,
                    };
                    expect(
                        await recoverSeaportSigner(vectors.chainId, data),
                    ).toBe(data.offerer);
                },
            );
        },
    );

    it("recovers the maker of the captured 163-byte OpenSea listing", async () => {
        const order = capturedBulkOrder();
        expect(computeSeaportOrderHash(order.seaportData!)).toBe(order.id);
        expect(
            (
                await recoverSeaportSigner(order.chainId, order.seaportData!)
            ).toLowerCase(),
        ).toBe(order.maker);
    });

    it("accepts the same proof with a standard 65-byte ECDSA signature", async () => {
        const order = capturedBulkOrder();
        const data = order.seaportData!;
        const signature = data.signature!;
        const expanded = serializeSignature(
            compactSignatureToSignature({
                r: `0x${signature.slice(2, 66)}`,
                yParityAndS: `0x${signature.slice(66, 130)}`,
            }),
        );
        data.signature = expanded + signature.slice(130);
        expect(
            (await recoverSeaportSigner(order.chainId, data)).toLowerCase(),
        ).toBe(order.maker);
    });

    it.each(["proof", "index", "order", "chain", "protocol"] as const)(
        "does not recover the maker after changing the %s",
        async (part) => {
            const order = capturedBulkOrder();
            const data = order.seaportData!;
            if (part === "proof")
                data.signature = data.signature!.slice(0, -2) + "00";
            if (part === "index")
                data.signature =
                    data.signature!.slice(0, 130) +
                    "000001" +
                    data.signature!.slice(136);
            if (part === "order") data.salt = "1";
            if (part === "chain") order.chainId = 2;
            if (part === "protocol")
                data.protocolAddress =
                    "0x00000000006687982678b03100B9bDC8be440814";
            expect(
                (await recoverSeaportSigner(order.chainId, data)).toLowerCase(),
            ).not.toBe(order.maker);
        },
    );

    it("uses only index bits within the proof height, as Seaport does", async () => {
        const order = capturedBulkOrder();
        const data = order.seaportData!;
        data.signature =
            data.signature!.slice(0, 130) +
            "fffff8" +
            data.signature!.slice(136);
        expect(
            (await recoverSeaportSigner(order.chainId, data)).toLowerCase(),
        ).toBe(order.maker);
    });

    it("does not treat a bulk signature prefix as a single-order signature", async () => {
        const order = capturedBulkOrder();
        order.seaportData!.signature = order.seaportData!.signature!.slice(
            0,
            130,
        );
        expect(
            (
                await recoverSeaportSigner(order.chainId, order.seaportData!)
            ).toLowerCase(),
        ).not.toBe(order.maker);
    });

    it.each([
        "0x",
        "00".repeat(163),
        `0x${"00".repeat(66)}`,
        `0x${"00".repeat(67)}`,
        `0x${"00".repeat(68)}`,
        `0x${"00".repeat(98)}`,
        `0x${"00".repeat(101)}`,
        `0x${"00".repeat(837)}`,
        `0x${"00".repeat(867)}`,
        `0x${"00".repeat(868)}`,
        `0x${"00".repeat(163)}0`,
        `0x${"00".repeat(162)}gg`,
    ])("rejects malformed or unsupported signature %#", async (signature) => {
        const order = capturedBulkOrder();
        order.seaportData!.signature = signature;
        await expect(
            recoverSeaportSigner(order.chainId, order.seaportData!),
        ).rejects.toThrow();
    });
});
