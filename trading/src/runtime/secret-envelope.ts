import { Buffer } from "node:buffer";
import { BiddingMandate } from "../domain/bidding-mandate.js";

export const SECRET_ENVELOPE_MAGIC = Buffer.from("AGBOTKEY", "ascii");
export const SECRET_ENVELOPE_VERSION = 2;
export const SECRET_KEY_LENGTH_BYTES = 32;
const HEADER_LENGTH = SECRET_ENVELOPE_MAGIC.length + 1 + 4;

export type TradingBotKind = "bidding" | "sniping";

export type TradingSecretEnvelopeMetadata = {
    walletId: string;
    address: string;
    botKind: TradingBotKind;
    chainId: number;
    biddingMandate: BiddingMandate | null;
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
    const metadata = JSON.parse(metadataBytes.toString("utf8")) as unknown;
    if (
        !isRecord(metadata) ||
        typeof metadata.walletId !== "string" ||
        typeof metadata.address !== "string" ||
        (metadata.botKind !== "bidding" && metadata.botKind !== "sniping") ||
        !Number.isSafeInteger(metadata.chainId) ||
        (metadata.chainId as number) <= 0
    ) {
        throw new Error("Secret envelope metadata is invalid");
    }
    const biddingMandate = parseEnvelopeBiddingMandate(
        metadata.botKind,
        metadata.biddingMandate,
        metadata.chainId as number,
    );

    const privateKeyBytes = buffer.subarray(
        HEADER_LENGTH + metadataLength,
        expectedTotalLength,
    );
    if (privateKeyBytes.length !== SECRET_KEY_LENGTH_BYTES) {
        throw new Error("Secret envelope private key payload is invalid");
    }

    return {
        metadata: {
            walletId: metadata.walletId,
            address: metadata.address,
            botKind: metadata.botKind,
            chainId: metadata.chainId as number,
            biddingMandate,
        },
        privateKeyBytes,
    };
}

function parseEnvelopeBiddingMandate(
    botKind: TradingBotKind,
    raw: unknown,
    chainId: number,
): BiddingMandate | null {
    if (botKind === "bidding") {
        if (raw === null || raw === undefined) {
            throw new Error("Bidding secret envelope mandate is missing");
        }
        return BiddingMandate.parse(raw, chainId);
    }
    if (raw !== null) {
        throw new Error("Sniping secret envelope contains a bidding mandate");
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
