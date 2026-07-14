import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
    DESKTOP_IPV4_LOOPBACK_HOST,
    NATS_INITIAL_INFO_MAX_BYTES,
    parseAndValidateNatsInitialInfoLine,
    readAndValidateNatsInitialInfo,
} from "./verify-staged-desktop-nats-loopback.mjs";

// Stable fixture port used only by pure initial-INFO parsing tests.
const NATS_INFO_FIXTURE_PORT = 42_720;
// Small timeout keeps the inert-socket failure test deterministic and focused.
const INERT_SOCKET_TIMEOUT_MS = 100;
// Separates writes so the socket reader receives realistic fragmented frames.
const FRAGMENT_WRITE_DELAY_MS = 5;

test("accepts the exact NATS initial INFO listener identity", () => {
    const identity = parseAndValidateNatsInitialInfoLine(
        encodeInitialInfoLine({
            host: DESKTOP_IPV4_LOOPBACK_HOST,
            port: NATS_INFO_FIXTURE_PORT,
            server_id: "fixture-server",
        }),
        {
            expectedHost: DESKTOP_IPV4_LOOPBACK_HOST,
            expectedPort: NATS_INFO_FIXTURE_PORT,
        },
    );

    assert.deepEqual(identity, {
        host: DESKTOP_IPV4_LOOPBACK_HOST,
        port: NATS_INFO_FIXTURE_PORT,
    });
});

test("rejects missing or non-canonical NATS initial INFO hosts", () => {
    for (const host of [undefined, "0.0.0.0", "localhost", "::1"]) {
        assert.throws(
            () =>
                parseAndValidateNatsInitialInfoLine(
                    encodeInitialInfoLine({
                        host,
                        port: NATS_INFO_FIXTURE_PORT,
                    }),
                    {
                        expectedHost: DESKTOP_IPV4_LOOPBACK_HOST,
                        expectedPort: NATS_INFO_FIXTURE_PORT,
                    },
                ),
            /initial INFO reported host/,
        );
    }
});

test("rejects invalid or mismatched NATS initial INFO ports", () => {
    for (const port of [
        undefined,
        String(NATS_INFO_FIXTURE_PORT),
        NATS_INFO_FIXTURE_PORT + 0.5,
        NATS_INFO_FIXTURE_PORT + 1,
    ]) {
        assert.throws(
            () =>
                parseAndValidateNatsInitialInfoLine(
                    encodeInitialInfoLine({
                        host: DESKTOP_IPV4_LOOPBACK_HOST,
                        port,
                    }),
                    {
                        expectedHost: DESKTOP_IPV4_LOOPBACK_HOST,
                        expectedPort: NATS_INFO_FIXTURE_PORT,
                    },
                ),
            /initial INFO reported port/,
        );
    }
});

test("rejects malformed and non-object NATS initial INFO payloads", () => {
    for (const line of ["INFO {", "INFO null", "INFO []", 'INFO "value"']) {
        assert.throws(
            () =>
                parseAndValidateNatsInitialInfoLine(Buffer.from(line, "utf8"), {
                    expectedHost: DESKTOP_IPV4_LOOPBACK_HOST,
                    expectedPort: NATS_INFO_FIXTURE_PORT,
                }),
            /invalid JSON|must be a JSON object/,
        );
    }
});

test("rejects a non-INFO first operation and an oversized INFO line", () => {
    assert.throws(
        () =>
            parseAndValidateNatsInitialInfoLine(Buffer.from("PING", "ascii"), {
                expectedHost: DESKTOP_IPV4_LOOPBACK_HOST,
                expectedPort: NATS_INFO_FIXTURE_PORT,
            }),
        /initial protocol operation must be INFO/,
    );

    assert.throws(
        () =>
            parseAndValidateNatsInitialInfoLine(
                Buffer.alloc(NATS_INITIAL_INFO_MAX_BYTES + 1, 0x49),
                {
                    expectedHost: DESKTOP_IPV4_LOOPBACK_HOST,
                    expectedPort: NATS_INFO_FIXTURE_PORT,
                },
            ),
        /initial INFO line exceeds/,
    );
});

test("reads an initial INFO frame fragmented across socket chunks", async (t) => {
    const endpoint = await startInfoFixtureServer(t, {
        createChunks: ({ host, port }) => {
            const payload = JSON.stringify({ host, port });
            return [
                "IN",
                "FO ",
                payload.slice(0, 5),
                payload.slice(5),
                "\r",
                "\n",
            ];
        },
        writeDelayMilliseconds: FRAGMENT_WRITE_DELAY_MS,
    });

    await readAndValidateNatsInitialInfo(endpoint);
});

test("rejects a socket INFO frame reporting a wildcard host", async (t) => {
    const endpoint = await startInfoFixtureServer(t, {
        createChunks: ({ port }) => [
            encodeInitialInfoFrame({ host: "0.0.0.0", port }),
        ],
    });

    await assert.rejects(
        readAndValidateNatsInitialInfo(endpoint),
        /initial INFO reported host 0\.0\.0\.0/,
    );
});

test("rejects an oversized unterminated initial socket frame", async (t) => {
    const endpoint = await startInfoFixtureServer(t, {
        createChunks: () => [
            Buffer.alloc(NATS_INITIAL_INFO_MAX_BYTES + 2, 0x49),
        ],
        closeAfterWrite: false,
    });

    await assert.rejects(
        readAndValidateNatsInitialInfo(endpoint),
        /initial INFO line exceeds/,
    );
});

test("rejects a socket that closes before completing initial INFO", async (t) => {
    const endpoint = await startInfoFixtureServer(t, {
        createChunks: () => ["INFO {"],
    });

    await assert.rejects(
        readAndValidateNatsInitialInfo(endpoint),
        /closed before sending a complete initial INFO/,
    );
});

test("rejects a socket that never sends initial INFO", async (t) => {
    const endpoint = await startInfoFixtureServer(t, {
        createChunks: () => [],
        closeAfterWrite: false,
    });

    await assert.rejects(
        readAndValidateNatsInitialInfo({
            ...endpoint,
            timeoutMilliseconds: INERT_SOCKET_TIMEOUT_MS,
        }),
        /Timed out waiting for bundled NATS initial INFO/,
    );
});

// Encodes the exact wire vocabulary intentionally asserted by these boundary tests.
function encodeInitialInfoLine(payload) {
    return Buffer.from(`INFO ${JSON.stringify(payload)}`, "utf8");
}

function encodeInitialInfoFrame(payload) {
    return Buffer.concat([
        encodeInitialInfoLine(payload),
        Buffer.from("\r\n", "ascii"),
    ]);
}

async function startInfoFixtureServer(
    t,
    { createChunks, closeAfterWrite = true, writeDelayMilliseconds = 0 },
) {
    const sockets = new Set();
    let endpoint;
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        // The verifier intentionally closes after INFO, so fixture writes may be reset.
        socket.on("error", () => {});
        void writeFixtureChunks({
            chunks: createChunks(endpoint),
            closeAfterWrite,
            socket,
            writeDelayMilliseconds,
        });
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(
            { host: DESKTOP_IPV4_LOOPBACK_HOST, port: 0, exclusive: true },
            resolve,
        );
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error(
            "NATS INFO fixture server did not report an IP socket.",
        );
    }
    endpoint = { host: DESKTOP_IPV4_LOOPBACK_HOST, port: address.port };

    t.after(async () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        if (server.listening) {
            await new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        }
    });

    return endpoint;
}

async function writeFixtureChunks({
    chunks,
    closeAfterWrite,
    socket,
    writeDelayMilliseconds,
}) {
    for (const [index, chunk] of chunks.entries()) {
        if (index > 0 && writeDelayMilliseconds > 0) {
            await delay(writeDelayMilliseconds);
        }
        if (socket.destroyed) {
            return;
        }
        socket.write(chunk);
    }
    if (closeAfterWrite && !socket.destroyed) {
        socket.end();
    }
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
