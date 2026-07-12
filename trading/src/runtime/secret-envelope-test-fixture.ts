import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRADING_BOT_KIND, type TradingBotKind } from "@artgod/shared/types";
import type { Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import {
    SECRET_ENVELOPE_HEADER_LENGTH,
    SECRET_ENVELOPE_MAGIC,
    SECRET_ENVELOPE_VERSION,
    SECRET_KEY_LENGTH_BYTES,
} from "./secret-envelope.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, "fixtures", "secret-envelope-v2.json");

type SecretEnvelopeFixture = {
    walletId: string;
    privateKeyHex: string;
    chainId: number;
    biddingMandate: unknown;
};

type SecretEnvelopeTestFrameOptions = {
    address?: string;
    botKind?: TradingBotKind;
    biddingMandate?: unknown;
    privateKeyBytes?: Buffer;
};

type SecretEnvelopeTestFrame = {
    frame: Buffer;
    privateKeyHex: string;
    address: string;
};

/** Builds a valid v2 test frame from the shared Rust/Node golden key and mandate. */
export function createSecretEnvelopeTestFrame(
    options: SecretEnvelopeTestFrameOptions = {},
): SecretEnvelopeTestFrame {
    const fixture = JSON.parse(
        readFileSync(fixturePath, "utf8"),
    ) as SecretEnvelopeFixture;
    const privateKeyBytes =
        options.privateKeyBytes ?? Buffer.from(fixture.privateKeyHex, "hex");
    if (privateKeyBytes.length !== SECRET_KEY_LENGTH_BYTES) {
        throw new Error(
            `Secret-envelope test key must contain exactly ${SECRET_KEY_LENGTH_BYTES} bytes`,
        );
    }
    const privateKeyHex = privateKeyBytes.toString("hex");

    const address =
        options.address ??
        privateKeyToAddress(`0x${fixture.privateKeyHex}` as Hex);
    const metadataBytes = Buffer.from(
        JSON.stringify({
            walletId: fixture.walletId,
            address,
            botKind: options.botKind ?? TRADING_BOT_KIND.Bidding,
            chainId: fixture.chainId,
            biddingMandate:
                options.biddingMandate === undefined
                    ? fixture.biddingMandate
                    : options.biddingMandate,
        }),
        "utf8",
    );
    const frame = Buffer.alloc(
        SECRET_ENVELOPE_HEADER_LENGTH +
            metadataBytes.length +
            SECRET_KEY_LENGTH_BYTES,
    );
    SECRET_ENVELOPE_MAGIC.copy(frame);
    frame.writeUInt8(SECRET_ENVELOPE_VERSION, SECRET_ENVELOPE_MAGIC.length);
    frame.writeUInt32BE(metadataBytes.length, SECRET_ENVELOPE_MAGIC.length + 1);
    metadataBytes.copy(frame, SECRET_ENVELOPE_HEADER_LENGTH);
    privateKeyBytes.copy(
        frame,
        SECRET_ENVELOPE_HEADER_LENGTH + metadataBytes.length,
    );

    privateKeyBytes.fill(0);
    metadataBytes.fill(0);

    return {
        frame,
        privateKeyHex,
        address,
    };
}
