import { createBaselineLedger, blockToWire } from "./ledger.mjs";
import {
    ZERO_ADDRESS,
    decodeCall,
    encodeResult,
    jsonSafe,
    wireQuantity,
    marketStreamEvent,
    signMarketOrder,
} from "./wire.mjs";

export class WorldRpcError extends Error {
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
    }
}

const invalid = (message) => new WorldRpcError(-32602, message);
const unavailable = (message) => new WorldRpcError(-32001, message);
const lower = (value) => String(value).toLowerCase();

/**
 * Controlled external provider views. No application adapter, queue or DB is
 * substituted. A height read resolves against this request's provider view,
 * even if earlier header reads observed another hash at the same height.
 */
export function createSimulationWorld(scenario = {}) {
    const ledger = createBaselineLedger(scenario);
    const providers = new Map(
        Object.entries(
            scenario.providers ?? {
                default: { branch: "A", head: ledger.initialHead },
                a: { branch: "A", head: ledger.initialHead },
                b: { branch: "B", head: ledger.initialHead },
            },
        ).map(([id, view]) => [id, { ...view }]),
    );
    const trace = [];
    const barriers = new Map();
    const scripts = (scenario.scripts ?? []).map((script) => ({
        ...script,
        used: false,
    }));
    const occurrences = new Map();
    const market = {
        listings: [ledger.orders.listing.raw],
        offers: [ledger.orders.bid.raw],
    };
    let requestIndex = 0;
    let sequence = 0;
    let phase = "initial";
    let closed = false;
    const addTrace = (entry) => {
        const event = jsonSafe({ sequence: ++sequence, phase, ...entry });
        trace.push(event);
        scenario.onTrace?.(event);
    };

    function providerView(id) {
        const view = providers.get(id);
        if (!view) throw invalid(`Unknown provider ${id}`);
        return view;
    }

    function setProviderView(id, patch) {
        const next = { ...providerView(id), ...patch };
        ledger.blockAt(next.branch, next.head);
        providers.set(id, next);
        addTrace({ type: "provider-view", provider: id, view: next });
    }
    for (const [id, view] of providers) {
        if (!id || !Number.isSafeInteger(view.head))
            throw new Error("Invalid simulation provider configuration");
        ledger.blockAt(view.branch, view.head);
    }

    function barrierState(name) {
        if (!barriers.has(name)) {
            let release;
            let reached;
            const released = new Promise((resolve) => (release = resolve));
            const arrived = new Promise((resolve) => (reached = resolve));
            barriers.set(name, {
                release,
                reached,
                released,
                arrived,
                pending: 0,
                isReleased: false,
            });
        }
        return barriers.get(name);
    }

    async function effect(action, context) {
        if (!action) return;
        if (action.phase) {
            phase = action.phase;
            addTrace({ type: "phase", value: phase });
        }
        if (action.view)
            setProviderView(action.provider ?? context.provider, action.view);
        for (const [id, view] of Object.entries(action.views ?? {}))
            setProviderView(id, view);
        if (action.barrier) {
            const barrier = barrierState(action.barrier);
            barrier.pending++;
            addTrace({
                type: "barrier-reached",
                name: action.barrier,
                requestIndex: context.requestIndex,
                provider: context.provider,
            });
            barrier.reached();
            await barrier.released;
            barrier.pending--;
            if (closed) throw unavailable("World closed while request held");
        }
    }

    function resolveBlock(view, selector = "latest") {
        if (selector && typeof selector === "object") {
            if (typeof selector.blockHash !== "string")
                throw invalid("Expected EIP-1898 blockHash selector");
            for (let number = 0; number <= view.head; number++) {
                const block = ledger.blockAt(view.branch, number);
                if (block.hash === lower(selector.blockHash)) return block;
            }
            // Noncanonical hashes are intentionally not silently mapped to a height.
            throw unavailable(
                "Requested block hash is not canonical at provider",
            );
        }
        let number;
        if (selector === "latest" || selector === "pending") number = view.head;
        else if (selector === "earliest") number = 0;
        else if (
            typeof selector === "string" &&
            /^0x[0-9a-f]+$/i.test(selector)
        )
            number = Number(BigInt(selector));
        else throw invalid("Expected Ethereum block tag or quantity");
        if (!Number.isSafeInteger(number) || number > view.head)
            throw unavailable(
                "Requested block height is not available at provider",
            );
        return ledger.blockAt(view.branch, number);
    }

    function callContract(view, tx, selector) {
        if (!tx || typeof tx !== "object") throw invalid("Missing call object");
        if (!tx.to)
            throw new WorldRpcError(
                -32000,
                "Fixture capability: deployless EVM execution unavailable; use production fallback",
            );
        const address = lower(tx.to);
        const known = Object.values(ledger.addresses).map(lower);
        if (!known.includes(address)) throw invalid("Unknown contract address");
        let call;
        try {
            call = decodeCall(tx.data ?? tx.input);
        } catch {
            throw invalid("Unknown contract selector");
        }
        const { functionName: name, args = [] } = call;
        const block = resolveBlock(view, selector);
        const state = ledger.stateAt(view.branch, block.number);
        const a = ledger.addresses;
        const requireContract = (expected) => {
            if (address !== lower(expected))
                throw invalid(`Unsupported ${name} contract`);
        };
        const requireAccount = (account) => {
            if (
                ![a.seller, a.bidder, a.buyer]
                    .map(lower)
                    .includes(lower(account))
            )
                throw invalid(`Unknown ${name} account`);
        };
        let result;
        switch (name) {
            case "ownerOf":
                requireContract(a.nft);
                result = state.owners.get(String(args[0]));
                if (!result)
                    throw new WorldRpcError(
                        3,
                        "execution reverted: nonexistent token",
                    );
                break;
            case "getApproved":
                requireContract(a.nft);
                if (!state.owners.has(String(args[0])))
                    throw new WorldRpcError(
                        3,
                        "execution reverted: nonexistent token",
                    );
                result = ZERO_ADDRESS;
                break;
            case "isApprovedForAll":
                requireContract(a.nft);
                requireAccount(args[0]);
                if (lower(args[1]) !== lower(a.seaport))
                    throw invalid("Unknown approval operator");
                result =
                    state.operators.get(
                        `${lower(args[0])}:${lower(args[1])}`,
                    ) ?? false;
                break;
            case "allowance":
                requireContract(a.weth);
                requireAccount(args[0]);
                if (lower(args[1]) !== lower(a.seaport))
                    throw invalid("Unknown allowance spender");
                result =
                    state.allowances.get(
                        `${lower(args[0])}:${lower(args[1])}`,
                    ) ?? 0n;
                break;
            case "balanceOf":
                requireContract(a.weth);
                requireAccount(args[0]);
                result = state.funding.get(lower(args[0])) ?? 0n;
                break;
            case "getOrderStatus":
                requireContract(a.seaport);
                if (
                    !Object.values(ledger.orders).some(
                        (o) => o.orderHash === lower(args[0]),
                    )
                )
                    throw invalid("Unknown Seaport order hash");
                result = state.statuses.get(lower(args[0])) ?? [
                    false,
                    false,
                    0n,
                    1n,
                ];
                break;
            case "getCounter":
                requireContract(a.seaport);
                requireAccount(args[0]);
                result = state.counters.get(lower(args[0])) ?? 0n;
                break;
            case "getConduit":
                requireContract(a.conduitController);
                // Baseline uses the protocol directly through a zero conduit key.
                if (BigInt(args[0]) !== 0n)
                    throw invalid("Unknown conduit key");
                result = [ZERO_ADDRESS, false];
                break;
            case "getChannels":
                requireContract(a.conduitController);
                throw invalid("No deployed conduit in baseline world");
            case "totalSupply":
                requireContract(a.nft);
                result = BigInt(state.owners.size);
                break;
            case "tokenByIndex": {
                requireContract(a.nft);
                const token = [...state.owners.keys()][Number(args[0])];
                if (token === undefined)
                    throw invalid("Token index outside supply");
                result = BigInt(token);
                break;
            }
            case "supportsInterface":
                requireContract(a.nft);
                result = [
                    "0x80ac58cd",
                    "0x5b5e139f",
                    "0x780e9d63",
                    "0x01ffc9a7",
                ].includes(lower(args[0]));
                break;
            case "tokenURI":
                requireContract(a.nft);
                if (!state.owners.has(String(args[0])))
                    throw invalid("Unknown metadata token");
                result = `data:application/json;base64,${Buffer.from(JSON.stringify({ name: `Simulation token ${args[0]}`, attributes: [] })).toString("base64")}`;
                break;
            default:
                throw invalid(`Unknown contract function ${name}`);
        }
        return { result: encodeResult(name, result), block };
    }

    function execute(provider, request) {
        const view = { ...providerView(provider) };
        const p = request.params ?? [];
        let block;
        let result;
        switch (request.method) {
            case "eth_chainId":
                result = wireQuantity(ledger.chainId);
                break;
            case "net_version":
                result = String(ledger.chainId);
                break;
            case "web3_clientVersion":
                result = "ArtGodExternalWorld/1";
                break;
            case "eth_blockNumber":
                result = wireQuantity(view.head);
                break;
            case "eth_getBlockByNumber":
                block = resolveBlock(view, p[0]);
                result = blockToWire(block, p[1] === true, ledger.transactions);
                break;
            case "eth_getBlockByHash":
                block = resolveBlock(view, {
                    blockHash: p[0],
                    requireCanonical: true,
                });
                result = blockToWire(block, p[1] === true, ledger.transactions);
                break;
            case "eth_call": {
                const response = callContract(view, p[0], p[1]);
                block = response.block;
                result = response.result;
                break;
            }
            case "eth_getBalance":
                if (
                    ![
                        ledger.addresses.seller,
                        ledger.addresses.bidder,
                        ledger.addresses.buyer,
                    ]
                        .map(lower)
                        .includes(lower(p[0]))
                )
                    throw invalid("Unknown native-balance account");
                block = resolveBlock(view, p[1]);
                result = wireQuantity(10_000_000_000_000_000_000n);
                break;
            case "eth_getCode":
                if (
                    ![
                        ledger.addresses.nft,
                        ledger.addresses.weth,
                        ledger.addresses.seaport,
                        ledger.addresses.conduitController,
                    ]
                        .map(lower)
                        .includes(lower(p[0]))
                )
                    throw invalid("Unknown code address");
                block = resolveBlock(view, p[1]);
                result = "0x60006000";
                break;
            case "eth_getLogs": {
                const filter = p[0] ?? {};
                const from = resolveBlock(
                    view,
                    filter.fromBlock ?? "earliest",
                ).number;
                const through = resolveBlock(
                    view,
                    filter.toBlock ?? "latest",
                ).number;
                if (from > through) throw invalid("Invalid log range");
                const addresses =
                    filter.address === undefined
                        ? null
                        : [filter.address].flat().map(lower);
                result = [];
                for (let n = from; n <= through; n++) {
                    for (const log of ledger.blockAt(view.branch, n).logs) {
                        if (
                            addresses &&
                            !addresses.includes(lower(log.address))
                        )
                            continue;
                        if (
                            !(filter.topics ?? []).every(
                                (topic, index) =>
                                    topic === null ||
                                    (Array.isArray(topic) ? topic : [topic])
                                        .map(lower)
                                        .includes(lower(log.topics[index])),
                            )
                        )
                            continue;
                        result.push(log);
                    }
                }
                break;
            }
            case "eth_getTransactionByHash":
            case "eth_getTransactionReceipt": {
                const item = (
                    request.method === "eth_getTransactionByHash"
                        ? ledger.transactions
                        : ledger.receipts
                ).get(lower(p[0]));
                result =
                    item &&
                    Number(BigInt(item.blockNumber)) <= view.head &&
                    ledger.blockAt(
                        view.branch,
                        Number(BigInt(item.blockNumber)),
                    ).hash === item.blockHash
                        ? item
                        : null;
                break;
            }
            default:
                throw new WorldRpcError(
                    -32601,
                    `Unsupported external RPC method ${request.method}`,
                );
        }
        return { result, view, block };
    }

    async function handleRpc(provider, request) {
        if (closed) throw unavailable("World is closed");
        if (
            !request ||
            request.jsonrpc !== "2.0" ||
            typeof request.method !== "string" ||
            (request.params !== undefined && !Array.isArray(request.params))
        )
            throw invalid("Malformed JSON-RPC request");
        const index = ++requestIndex;
        let call;
        if (request.method === "eth_call") {
            try {
                call = decodeCall(
                    request.params?.[0]?.data ?? request.params?.[0]?.input,
                );
            } catch {
                /* Unknown wire input is rejected by execute. */
            }
        }
        const occurrenceKey = `${provider}:${request.method}:${call?.functionName ?? ""}`;
        const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
        occurrences.set(occurrenceKey, occurrence);
        const context = {
            provider,
            requestIndex: index,
            method: request.method,
            functionName: call?.functionName,
            occurrence,
        };
        const matches = (script) =>
            Object.entries(script.when ?? {}).every(
                ([key, value]) =>
                    (key === "phase" ? phase : context[key]) === value,
            );
        const selected = scripts.filter(
            (script) => !script.used && matches(script),
        );
        for (const script of selected) script.used = true;
        addTrace({
            type: "request",
            ...context,
            params: request.params,
            view: { ...providerView(provider) },
        });
        try {
            for (const script of selected) await effect(script.before, context);
            const faultScript = selected.find((script) => script.fault);
            const fault = faultScript?.fault;
            if (fault) {
                faultScript.applied = true;
                addTrace({
                    type: "fault-injected",
                    ...context,
                    fault: faultScript.id ?? null,
                });
                throw new WorldRpcError(
                    fault.code ?? -32000,
                    fault.message ?? "Scripted RPC failure",
                    fault.data,
                );
            }
            // Resolve only after before-effect barriers; result barriers retain
            // the encoded old response while later requests see the changed view.
            const response = execute(provider, request);
            addTrace({
                type: "read",
                ...context,
                view: response.view,
                blockHash: response.block?.hash,
                blockNumber: response.block?.number,
            });
            for (const script of selected) await effect(script.after, context);
            addTrace({ type: "response", ...context, view: response.view });
            return response.result;
        } catch (error) {
            addTrace({
                type: "error",
                ...context,
                code: error.code ?? -32603,
                message: error.message,
            });
            throw error;
        }
    }

    return {
        ledger,
        market,
        trace,
        recordExternal(event) {
            addTrace({ ...event, boundary: "external-wire" });
        },
        recordAction(action, detail = {}) {
            addTrace({ ...detail, type: "scenario-action", action });
        },
        setMarket(patch) {
            for (const lane of ["listings", "offers"]) {
                if (patch[lane] === undefined) continue;
                if (!Array.isArray(patch[lane]))
                    throw new Error(`Expected ${lane} records`);
                market[lane] = patch[lane];
            }
            addTrace({
                type: "market-inventory",
                listings: market.listings.map((order) => order.order_hash),
                offers: market.offers.map((order) => order.order_hash),
            });
        },
        async signMarketOrders() {
            for (const order of Object.values(ledger.orders))
                await signMarketOrder(
                    order,
                    ledger.addresses.seaport,
                    ledger.chainId,
                );
        },
        streamEventFor(name, { observedAt = ledger.epochSeconds } = {}) {
            const order = ledger.orders[name];
            if (!order) throw new Error(`Unknown fixture order ${name}`);
            if (!Number.isSafeInteger(observedAt) || observedAt < 1)
                throw new Error("Stream observation requires epoch seconds");
            return marketStreamEvent(
                order,
                ledger.addresses,
                ledger.collectionSlug,
                observedAt,
            );
        },
        handleRpc,
        setProviderView,
        providerView: (id) => ({ ...providerView(id) }),
        advanceHead(head, { provider } = {}) {
            for (const id of provider ? [provider] : providers.keys())
                setProviderView(id, { head });
        },
        switchBranch(branch, { provider, head } = {}) {
            for (const id of provider ? [provider] : providers.keys())
                setProviderView(id, {
                    branch,
                    ...(head === undefined ? {} : { head }),
                });
        },
        setPhase(value) {
            phase = value;
            addTrace({ type: "phase", value });
        },
        release(name) {
            const barrier = barrierState(name);
            barrier.isReleased = true;
            barrier.release();
            addTrace({ type: "barrier-release", name });
        },
        waitForBarrier: (name) => barrierState(name).arrived,
        snapshot() {
            return jsonSafe({
                version: 1,
                phase,
                epochSeconds: ledger.epochSeconds,
                addresses: ledger.addresses,
                collectionSlug: ledger.collectionSlug,
                orders: ledger.orders,
                providers: Object.fromEntries(providers),
                barriers: [...barriers].map(([name, b]) => ({
                    name,
                    pending: b.pending,
                    released: b.isReleased,
                })),
                scripts: scripts.map((script) => ({
                    ...(script.id === undefined ? {} : { id: script.id }),
                    when: script.when,
                    used: script.used,
                    ...(script.fault
                        ? { applied: script.applied === true }
                        : {}),
                })),
                requests: requestIndex,
            });
        },
        close() {
            closed = true;
            for (const barrier of barriers.values()) barrier.release();
        },
    };
}
