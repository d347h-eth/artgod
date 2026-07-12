import { Buffer } from "node:buffer";
import { TRADING_BOT_KIND, type TradingBotKind } from "@artgod/shared/types";
import { BiddingMandate } from "../domain/bidding-mandate.js";

export type { TradingBotKind } from "@artgod/shared/types";

export const SECRET_ENVELOPE_MAGIC = Buffer.from("AGBOTKEY", "ascii");
export const SECRET_ENVELOPE_VERSION = 3;
export const SECRET_KEY_LENGTH_BYTES = 32;
const VERSION_FIELD_LENGTH_BYTES = 1;
const METADATA_LENGTH_FIELD_LENGTH_BYTES = 4;
// Bound parent-declared allocation while leaving ample room for native authorization metadata.
export const SECRET_ENVELOPE_MAX_METADATA_LENGTH_BYTES = 1024 * 1024;
const VERSION_OFFSET = SECRET_ENVELOPE_MAGIC.length;
const METADATA_LENGTH_OFFSET = VERSION_OFFSET + VERSION_FIELD_LENGTH_BYTES;

/** Byte length needed to discover one complete secret-envelope frame. */
export const SECRET_ENVELOPE_HEADER_LENGTH =
    METADATA_LENGTH_OFFSET + METADATA_LENGTH_FIELD_LENGTH_BYTES;
// Largest frame accepted from the native desktop parent.
const SECRET_ENVELOPE_MAX_FRAME_LENGTH =
    SECRET_ENVELOPE_HEADER_LENGTH +
    SECRET_ENVELOPE_MAX_METADATA_LENGTH_BYTES +
    SECRET_KEY_LENGTH_BYTES;

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

/** Resolves the exact v3 frame length once the complete header is available. */
export function resolveSecretEnvelopeFrameLength(
    buffer: Buffer,
): number | null {
    if (buffer.length < SECRET_ENVELOPE_HEADER_LENGTH) {
        return null;
    }

    const magic = buffer.subarray(0, SECRET_ENVELOPE_MAGIC.length);
    if (!magic.equals(SECRET_ENVELOPE_MAGIC)) {
        throw new Error("Secret envelope magic is invalid");
    }

    const version = buffer.readUInt8(VERSION_OFFSET);
    if (version !== SECRET_ENVELOPE_VERSION) {
        throw new Error(`Secret envelope version is unsupported: ${version}`);
    }

    const metadataLength = buffer.readUInt32BE(METADATA_LENGTH_OFFSET);
    const frameLength =
        SECRET_ENVELOPE_HEADER_LENGTH +
        metadataLength +
        SECRET_KEY_LENGTH_BYTES;
    if (frameLength > SECRET_ENVELOPE_MAX_FRAME_LENGTH) {
        throw new Error("Secret envelope metadata exceeds the maximum length");
    }
    return frameLength;
}

export function parseSecretEnvelope(buffer: Buffer): TradingSecretEnvelope {
    if (
        buffer.length <
        SECRET_ENVELOPE_HEADER_LENGTH + SECRET_KEY_LENGTH_BYTES
    ) {
        throw new Error("Secret envelope is truncated");
    }

    const expectedTotalLength = resolveSecretEnvelopeFrameLength(buffer);
    if (expectedTotalLength === null) {
        throw new Error("Secret envelope is truncated");
    }
    if (buffer.length !== expectedTotalLength) {
        throw new Error("Secret envelope length is invalid");
    }

    const metadataLength = buffer.readUInt32BE(METADATA_LENGTH_OFFSET);

    const metadataBytes = buffer.subarray(
        SECRET_ENVELOPE_HEADER_LENGTH,
        SECRET_ENVELOPE_HEADER_LENGTH + metadataLength,
    );
    const metadata = JSON.parse(metadataBytes.toString("utf8")) as unknown;
    if (
        !isRecord(metadata) ||
        typeof metadata.walletId !== "string" ||
        typeof metadata.address !== "string" ||
        (metadata.botKind !== TRADING_BOT_KIND.Bidding &&
            metadata.botKind !== TRADING_BOT_KIND.Sniping) ||
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
        SECRET_ENVELOPE_HEADER_LENGTH + metadataLength,
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
    if (botKind === TRADING_BOT_KIND.Bidding) {
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
