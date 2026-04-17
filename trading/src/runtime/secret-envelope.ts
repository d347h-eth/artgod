import { Buffer } from "node:buffer";

export const SECRET_ENVELOPE_MAGIC = Buffer.from("AGBOTKEY", "ascii");
export const SECRET_ENVELOPE_VERSION = 1;
export const SECRET_KEY_LENGTH_BYTES = 32;
const HEADER_LENGTH = SECRET_ENVELOPE_MAGIC.length + 1 + 4;

export type TradingBotKind = "bidding" | "sniping";

export type TradingSecretEnvelopeMetadata = {
    walletId: string;
    address: string;
    botKind: TradingBotKind;
    chainId: number;
};

export type TradingSecretEnvelope = {
    metadata: TradingSecretEnvelopeMetadata;
    privateKeyBytes: Buffer;
};

export function parseSecretEnvelope(buffer: Buffer): TradingSecretEnvelope {
    if (buffer.length < HEADER_LENGTH + SECRET_KEY_LENGTH_BYTES) {
        throw new Error("Secret envelope is truncated");
    }

    const magic = buffer.subarray(0, SECRET_ENVELOPE_MAGIC.length);
    if (!magic.equals(SECRET_ENVELOPE_MAGIC)) {
        throw new Error("Secret envelope magic is invalid");
    }

    const version = buffer.readUInt8(SECRET_ENVELOPE_MAGIC.length);
    if (version !== SECRET_ENVELOPE_VERSION) {
        throw new Error(`Secret envelope version is unsupported: ${version}`);
    }

    const metadataLength = buffer.readUInt32BE(
        SECRET_ENVELOPE_MAGIC.length + 1,
    );
    const expectedTotalLength =
        HEADER_LENGTH + metadataLength + SECRET_KEY_LENGTH_BYTES;
    if (buffer.length !== expectedTotalLength) {
        throw new Error("Secret envelope length is invalid");
    }

    const metadataBytes = buffer.subarray(
        HEADER_LENGTH,
        HEADER_LENGTH + metadataLength,
    );
    const metadata = JSON.parse(
        metadataBytes.toString("utf8"),
    ) as Partial<TradingSecretEnvelopeMetadata>;
    if (
        typeof metadata.walletId !== "string" ||
        typeof metadata.address !== "string" ||
        (metadata.botKind !== "bidding" && metadata.botKind !== "sniping") ||
        typeof metadata.chainId !== "number"
    ) {
        throw new Error("Secret envelope metadata is invalid");
    }

    const privateKeyBytes = Buffer.from(
        buffer.subarray(HEADER_LENGTH + metadataLength, expectedTotalLength),
    );
    if (privateKeyBytes.length !== SECRET_KEY_LENGTH_BYTES) {
        throw new Error("Secret envelope private key payload is invalid");
    }

    return {
        metadata: {
            walletId: metadata.walletId,
            address: metadata.address,
            botKind: metadata.botKind,
            chainId: metadata.chainId,
        },
        privateKeyBytes,
    };
}
