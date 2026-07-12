import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readSecretEnvelopeFromParent } from "./parent-secret-channel.js";
import {
    SECRET_ENVELOPE_HEADER_LENGTH,
    SECRET_ENVELOPE_MAGIC,
    SECRET_ENVELOPE_MAX_METADATA_LENGTH_BYTES,
    SECRET_ENVELOPE_VERSION,
} from "./secret-envelope.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, "fixtures", "secret-envelope-v2.json");

type SecretEnvelopeFixture = {
    payloadHex: string;
};

function loadPayload(): Buffer {
    const fixture = JSON.parse(
        readFileSync(fixturePath, "utf8"),
    ) as SecretEnvelopeFixture;
    return Buffer.from(fixture.payloadHex, "hex");
}

function writeFragments(
    input: PassThrough,
    payload: Buffer,
    fragmentLengths: number[],
): void {
    let offset = 0;
    for (const fragmentLength of fragmentLengths) {
        const end = Math.min(offset + fragmentLength, payload.length);
        input.write(Buffer.from(payload.subarray(offset, end)));
        offset = end;
    }
    if (offset < payload.length) {
        input.write(Buffer.from(payload.subarray(offset)));
    }
}

describe("readSecretEnvelopeFromParent", () => {
    it("resolves a fragmented frame before the parent closes stdin", async () => {
        const input = new PassThrough();
        const payload = loadPayload();
        const onParentChannelFailure = vi.fn();
        const framePromise = readSecretEnvelopeFromParent(
            input,
            onParentChannelFailure,
        );

        writeFragments(input, payload, [3, 2, 7, 1, 19, 64]);

        const channel = await framePromise;
        const frame = channel.envelope;
        expect(frame.equals(payload)).toBe(true);
        expect(input.readableEnded).toBe(false);
        expect(onParentChannelFailure).not.toHaveBeenCalled();

        channel.releaseAfterCleanup();
        frame.fill(0);
        payload.fill(0);
    });

    it("rejects a frame truncated by parent closure", async () => {
        const input = new PassThrough();
        const payload = loadPayload();
        const framePromise = readSecretEnvelopeFromParent(input, vi.fn());

        input.end(Buffer.from(payload.subarray(0, payload.length - 1)));

        await expect(framePromise).rejects.toThrow("truncated");
        payload.fill(0);
    });

    it("rejects bytes appended to the initial frame", async () => {
        const input = new PassThrough();
        const payload = loadPayload();
        const framePromise = readSecretEnvelopeFromParent(input, vi.fn());

        input.write(Buffer.concat([payload, Buffer.from([0x01])]));

        await expect(framePromise).rejects.toThrow(
            "data after the complete frame",
        );
        payload.fill(0);
    });

    it("rejects a forged metadata length before buffering its declared frame", async () => {
        const input = new PassThrough();
        const forgedHeader = Buffer.alloc(SECRET_ENVELOPE_HEADER_LENGTH);
        SECRET_ENVELOPE_MAGIC.copy(forgedHeader);
        forgedHeader.writeUInt8(
            SECRET_ENVELOPE_VERSION,
            SECRET_ENVELOPE_MAGIC.length,
        );
        forgedHeader.writeUInt32BE(
            SECRET_ENVELOPE_MAX_METADATA_LENGTH_BYTES + 1,
            SECRET_ENVELOPE_MAGIC.length + 1,
        );
        const framePromise = readSecretEnvelopeFromParent(input, vi.fn());

        input.write(forgedHeader);

        await expect(framePromise).rejects.toThrow("maximum length");
        expect(forgedHeader.equals(Buffer.alloc(forgedHeader.length))).toBe(
            true,
        );
    });

    it("reports bytes received after delivering the frame", async () => {
        const input = new PassThrough();
        const payload = loadPayload();
        const onParentChannelFailure = vi.fn();
        const framePromise = readSecretEnvelopeFromParent(
            input,
            onParentChannelFailure,
        );

        input.write(Buffer.from(payload));
        const channel = await framePromise;
        const frame = channel.envelope;
        input.write(Buffer.from([0x01]));

        expect(onParentChannelFailure).toHaveBeenCalledOnce();
        expect(onParentChannelFailure.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                message: expect.stringContaining(
                    "data after the complete frame",
                ),
            }),
        );

        frame.fill(0);
        payload.fill(0);
    });

    it("reports parent closure after delivering the frame", async () => {
        const input = new PassThrough();
        const payload = loadPayload();
        let resolveFailure: ((error: Error) => void) | undefined;
        const failure = new Promise<Error>((resolve) => {
            resolveFailure = resolve;
        });
        const framePromise = readSecretEnvelopeFromParent(input, (error) => {
            resolveFailure?.(error);
        });

        input.write(Buffer.from(payload));
        const channel = await framePromise;
        const frame = channel.envelope;
        input.end();

        await expect(failure).resolves.toEqual(
            expect.objectContaining({
                message: expect.stringContaining("closed unexpectedly"),
            }),
        );

        frame.fill(0);
        payload.fill(0);
    });

    it("releases the liveness listeners after graceful runtime cleanup", async () => {
        const input = new PassThrough();
        const payload = loadPayload();
        const onParentChannelFailure = vi.fn();
        const channelPromise = readSecretEnvelopeFromParent(
            input,
            onParentChannelFailure,
        );

        input.write(Buffer.from(payload));
        const channel = await channelPromise;
        channel.releaseAfterCleanup();
        input.end();

        await new Promise((resolve) => setImmediate(resolve));
        expect(onParentChannelFailure).not.toHaveBeenCalled();
        expect(input.readableFlowing).toBe(false);

        channel.envelope.fill(0);
        payload.fill(0);
    });
});
