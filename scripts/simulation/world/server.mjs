import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { WebSocketServer } from "ws";
import { createSimulationWorld } from "./world.mjs";
import { jsonSafe } from "./wire.mjs";
import { METADATA_TRANSPORT, RPC_RESPONSE_EVENT } from "./contract.mjs";

const MAX_REQUEST_BYTES = 1_048_576;

/** Real HTTP/TLS and Phoenix WebSocket surfaces for unchanged production SDKs. */
export async function startWorldServer({
    host = "127.0.0.1",
    port = 0,
    tls,
    scenario = {},
    urlHostname,
} = {}) {
    if (!["127.0.0.1", "::1"].includes(host))
        throw new Error("External simulation server must bind loopback");
    const world = createSimulationWorld(scenario);
    await world.signMarketOrders();
    const sockets = new Set();
    const subscriptions = new Map();
    const websocket = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_REQUEST_BYTES,
    });
    const send = (response, status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(jsonSafe(body)));
    };
    async function rpc(provider, body) {
        const before = world.trace.at(-1)?.sequence ?? 0;
        const pending = world.handleRpc(provider, body);
        // handleRpc appends its identity synchronously before the first await.
        // Capture it before another batch member/request can enter the world.
        const request = world.trace.findLast(
            (entry) => entry.type === "request" && entry.sequence > before,
        );
        let answer;
        try {
            const result = await pending;
            answer = { jsonrpc: "2.0", id: body.id ?? null, result };
        } catch (error) {
            answer = {
                jsonrpc: "2.0",
                id: body?.id ?? null,
                error: {
                    code: error.code ?? -32603,
                    message: error.message,
                    ...(error.data === undefined ? {} : { data: error.data }),
                },
            };
        }
        return {
            answer,
            receipt: request
                ? {
                      requestIndex: request.requestIndex,
                      provider,
                      method: request.method,
                      outcome: answer.error ? "error" : "response",
                      ...(answer.error
                          ? {
                                code: answer.error.code,
                                message: answer.error.message,
                            }
                          : {}),
                  }
                : undefined,
        };
    }
    const handler = async (request, response) => {
        try {
            const url = new URL(request.url, "http://external-world.invalid");
            world.recordExternal({
                type: "http-request",
                method: request.method,
                path: url.pathname,
                query: [...url.searchParams],
            });
            const rpcMatch = /^\/rpc\/([a-z0-9_-]+)$/i.exec(url.pathname);
            const metadataMatch = /^\/metadata\/(1|2)$/.exec(url.pathname);
            if (request.method === "GET" && metadataMatch) {
                // The onchain URI stays fixed at every historical block. Only
                // the external HTTP document changes during metadata recovery.
                response.writeHead(200, { "content-type": "application/json" });
                response.end(world.tokenMetadataDocument(metadataMatch[1]));
                return;
            }
            if (request.method === "POST" && rpcMatch) {
                const chunks = [];
                let size = 0;
                for await (const chunk of request) {
                    size += chunk.length;
                    if (size > MAX_REQUEST_BYTES) {
                        send(response, 413, {
                            error: "Simulation request too large",
                        });
                        return;
                    }
                    chunks.push(chunk);
                }
                let body;
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString());
                } catch {
                    send(response, 200, {
                        jsonrpc: "2.0",
                        id: null,
                        error: { code: -32700, message: "Invalid JSON" },
                    });
                    return;
                }
                // Batch elements are started in wire order; per-request scripts
                // still govern actual read and completion boundaries.
                const replies = Array.isArray(body)
                    ? await Promise.all(
                          body.map((item) => rpc(rpcMatch[1], item)),
                      )
                    : await rpc(rpcMatch[1], body);
                const members = Array.isArray(body) ? replies : [replies];
                // One listener per HTTP response, even for a large JSON-RPC batch.
                // Aborted responses without finish cannot earn delivery evidence.
                response.once("finish", () => {
                    for (const { receipt } of members)
                        if (receipt)
                            world.recordExternal({
                                type: RPC_RESPONSE_EVENT.Finished,
                                ...receipt,
                            });
                });
                send(
                    response,
                    200,
                    Array.isArray(body)
                        ? replies.map((entry) => entry.answer)
                        : replies.answer,
                );
                return;
            }
            const marketMatch =
                /^\/api\/v2\/(listings|offers)\/collection\/([^/]+)\/all$/.exec(
                    url.pathname,
                );
            if (request.method === "GET" && marketMatch) {
                if (
                    decodeURIComponent(marketMatch[2]) !==
                    world.ledger.collectionSlug
                ) {
                    send(response, 404, {
                        error: "Unknown simulated collection",
                    });
                    return;
                }
                const size = Number(url.searchParams.get("limit") ?? "200");
                const cursor = url.searchParams.get("next");
                const offset =
                    cursor === null
                        ? 0
                        : /^offset:\d+$/.test(cursor)
                          ? Number(cursor.slice(7))
                          : NaN;
                if (
                    !Number.isSafeInteger(size) ||
                    size < 1 ||
                    size > 200 ||
                    !Number.isSafeInteger(offset)
                ) {
                    send(response, 400, {
                        error: "Invalid simulated cursor or page size",
                    });
                    return;
                }
                const lane = marketMatch[1];
                const records = world.market[lane];
                world.recordExternal({
                    type: "market-page",
                    lane,
                    offset,
                    size,
                    identities: records
                        .slice(offset, offset + size)
                        .map((order) => order.order_hash),
                });
                send(response, 200, {
                    [lane]: records.slice(offset, offset + size),
                    next:
                        offset + size < records.length
                            ? `offset:${offset + size}`
                            : null,
                });
                return;
            }
            // Bootstrap identity probes use the real shared REST client.
            const nftMatch =
                /^\/api\/v2\/chain\/ethereum\/contract\/([^/]+)\/nfts\/([^/]+)$/.exec(
                    url.pathname,
                );
            const contractMatch =
                /^\/api\/v2\/chain\/ethereum\/contract\/([^/]+)$/.exec(
                    url.pathname,
                );
            if (request.method === "GET" && (nftMatch || contractMatch)) {
                const match = nftMatch ?? contractMatch;
                if (
                    match[1].toLowerCase() !==
                        world.ledger.addresses.nft.toLowerCase() ||
                    (nftMatch && !["1", "2"].includes(nftMatch[2]))
                ) {
                    send(response, 404, { error: "Unknown simulated NFT" });
                    return;
                }
                const collection = world.ledger.collectionSlug;
                send(
                    response,
                    200,
                    nftMatch
                        ? {
                              nft: {
                                  identifier: nftMatch[2],
                                  contract: world.ledger.addresses.nft,
                                  collection,
                              },
                          }
                        : { address: world.ledger.addresses.nft, collection },
                );
                return;
            }
            if (
                request.method === "GET" &&
                url.pathname ===
                    `/api/v2/collections/${world.ledger.collectionSlug}`
            ) {
                send(response, 200, {
                    collection: world.ledger.collectionSlug,
                    contracts: [
                        {
                            address: world.ledger.addresses.nft,
                            chain: "ethereum",
                        },
                    ],
                });
                return;
            }
            send(response, 404, {
                error: `Unsupported simulated HTTP route ${request.method} ${url.pathname}`,
            });
        } catch (error) {
            if (!response.headersSent)
                send(response, 500, { error: error.message });
            else response.destroy(error);
        }
    };
    const server = tls
        ? createHttpsServer(tls, handler)
        : createHttpServer(handler);
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url, "http://external-world.invalid");
        if (url.pathname !== "/socket/websocket") {
            socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
            return;
        }
        websocket.handleUpgrade(request, socket, head, (client) =>
            websocket.emit("connection", client),
        );
    });
    websocket.on("connection", (client) => {
        const channels = new Map();
        subscriptions.set(client, channels);
        client.on("close", () => subscriptions.delete(client));
        client.on("error", () => {});
        client.on("message", (bytes) => {
            let message;
            try {
                message = JSON.parse(String(bytes));
            } catch {
                client.close(1007, "Invalid JSON");
                return;
            }
            if (!Array.isArray(message) || message.length !== 5) {
                client.close(1007, "Expected Phoenix v2 envelope");
                return;
            }
            const [joinRef, ref, topic, event, payload] = message;
            world.recordExternal({
                type: "stream-request",
                topic,
                event,
                eventTypes: payload?.event_types,
            });
            let status = "ok";
            if (event === "phx_join") {
                if (topic !== `collection:${world.ledger.collectionSlug}`)
                    status = "error";
                else
                    channels.set(topic, {
                        joinRef,
                        eventTypes: payload?.event_types,
                    });
            } else if (event === "phx_leave") channels.delete(topic);
            else if (!(event === "heartbeat" && topic === "phoenix"))
                status = "error";
            client.send(
                JSON.stringify([
                    joinRef,
                    ref,
                    topic,
                    "phx_reply",
                    { status, response: {} },
                ]),
            );
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
    });
    const actualPort = server.address().port;
    const scheme = tls ? "https" : "http";
    const hostname = urlHostname ?? (host === "::1" ? "[::1]" : host);
    const url = `${scheme}://${hostname}:${actualPort}`;
    if (scenario.metadataTransport === METADATA_TRANSPORT.Http)
        world.publishMetadataAt(url);
    return {
        url,
        rpcUrl: `${url}/rpc/default`,
        rpcUrls: Object.fromEntries(
            Object.keys(world.snapshot().providers).map((id) => [
                id,
                `${url}/rpc/${id}`,
            ]),
        ),
        streamUrl: `${tls ? "wss" : "ws"}://${hostname}:${actualPort}/socket`,
        world,
        pushStreamEvent({
            collectionSlug = world.ledger.collectionSlug,
            eventType,
            payload,
        }) {
            let recipients = 0;
            for (const [client, channels] of subscriptions) {
                const topic = `collection:${collectionSlug}`;
                const channel = channels.get(topic);
                if (
                    !channel ||
                    client.readyState !== 1 ||
                    (channel.eventTypes &&
                        !channel.eventTypes.includes(eventType))
                )
                    continue;
                client.send(
                    JSON.stringify([
                        channel.joinRef,
                        null,
                        topic,
                        eventType,
                        payload,
                    ]),
                );
                recipients++;
            }
            world.recordExternal({
                type: "stream-push",
                collectionSlug,
                eventType,
                recipients,
                orderHash: payload?.payload?.order_hash,
            });
            return recipients;
        },
        subscriptionCount: () =>
            [...subscriptions.values()].reduce(
                (n, channels) => n + channels.size,
                0,
            ),
        async close() {
            world.close();
            for (const client of subscriptions.keys()) client.terminate();
            for (const socket of sockets) socket.destroy();
            await new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
            await new Promise((resolve) => websocket.close(resolve));
        },
    };
}
