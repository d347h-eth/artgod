import {
    decodeFunctionData,
    decodeDeployData,
    deploylessCallViaBytecodeBytecode,
    encodeDeployData,
    encodeFunctionData,
    encodeAbiParameters,
    encodeEventTopics,
    encodeFunctionResult,
    hashStruct,
    keccak256,
    parseAbi,
    stringToHex,
    toHex,
    multicall3Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Public, deliberately trivial fixture keys. Never read operator wallet input.
export const WORLD_FIXTURE_KEYS = Object.freeze({
    seller: `0x${"0".repeat(63)}1`,
    bidder: `0x${"0".repeat(63)}2`,
    buyer: `0x${"0".repeat(63)}3`,
});
export const WORLD_FIXTURE_ACCOUNTS = Object.fromEntries(
    Object.entries(WORLD_FIXTURE_KEYS).map(([name, key]) => [
        name,
        privateKeyToAccount(key),
    ]),
);

// Deliberate external Ethereum/Seaport wire vocabulary. These describe simulated
// contracts, not ArtGod's production reducers, storage or order eligibility.
export const CONTRACT_ABI = parseAbi([
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function getApproved(uint256 tokenId) view returns (address)",
    "function isApprovedForAll(address owner,address operator) view returns (bool)",
    "function tokenURI(uint256 tokenId) view returns (string)",
    "function totalSupply() view returns (uint256)",
    "function tokenByIndex(uint256 index) view returns (uint256)",
    "function supportsInterface(bytes4 interfaceId) view returns (bool)",
    "function allowance(address owner,address spender) view returns (uint256)",
    "function balanceOf(address owner) view returns (uint256)",
    "function getOrderStatus(bytes32 orderHash) view returns (bool isValidated,bool isCancelled,uint256 totalFilled,uint256 totalSize)",
    "function getCounter(address offerer) view returns (uint256)",
    "function getConduit(bytes32 conduitKey) view returns (address conduit,bool exists)",
    "function getChannels(address conduit) view returns (address[] channels)",
]);

export const TRANSFER_ABI = parseAbi([
    "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);

export const FULFILLED_ABI = parseAbi([
    "event OrderFulfilled(bytes32 orderHash,address indexed offerer,address indexed zone,address recipient,(uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer,(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)",
]);

export const COUNTER_ABI = parseAbi([
    "event CounterIncremented(uint256 newCounter,address indexed offerer)",
]);

const ORDER_TYPES = {
    OrderComponents: [
        { name: "offerer", type: "address" },
        { name: "zone", type: "address" },
        { name: "offer", type: "OfferItem[]" },
        { name: "consideration", type: "ConsiderationItem[]" },
        { name: "orderType", type: "uint8" },
        { name: "startTime", type: "uint256" },
        { name: "endTime", type: "uint256" },
        { name: "zoneHash", type: "bytes32" },
        { name: "salt", type: "uint256" },
        { name: "conduitKey", type: "bytes32" },
        { name: "counter", type: "uint256" },
    ],
    OfferItem: [
        { name: "itemType", type: "uint8" },
        { name: "token", type: "address" },
        { name: "identifierOrCriteria", type: "uint256" },
        { name: "startAmount", type: "uint256" },
        { name: "endAmount", type: "uint256" },
    ],
    ConsiderationItem: [
        { name: "itemType", type: "uint8" },
        { name: "token", type: "address" },
        { name: "identifierOrCriteria", type: "uint256" },
        { name: "startAmount", type: "uint256" },
        { name: "endAmount", type: "uint256" },
        { name: "recipient", type: "address" },
    ],
};

export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
export const ZERO_HASH = `0x${"0".repeat(64)}`;
export const EMPTY_BLOOM = `0x${"0".repeat(512)}`;
export const hashIdentity = (text) => keccak256(stringToHex(text));
export const wireQuantity = (value) => toHex(BigInt(value));
export const jsonSafe = (value) =>
    JSON.parse(
        JSON.stringify(value, (_key, item) =>
            typeof item === "bigint" ? item.toString() : item,
        ),
    );

export function decodeCall(data) {
    return decodeFunctionData({ abi: CONTRACT_ABI, data });
}

export function encodeResult(functionName, result) {
    return encodeFunctionResult({ abi: CONTRACT_ABI, functionName, result });
}

// Boundary fixture for the installed viem 2.54.6 Multicall3 creation code. The
// wrapper constant is public SDK input; the nested bytecode is not exported.
// Unknown code must expose a missing fixture capability, not execute as zeroes.
export const DEPLOYLESS_MULTICALL3 = Object.freeze({
    functionName: "aggregate3",
    creationCodeHash:
        "0x0388a0d41a63e5bbe5b1005f52975ef622c77817a483f36849c5447365555071",
    maximumCalls: 64,
});
const DEPLOYLESS_CONSTRUCTOR = parseAbi(["constructor(bytes,bytes)"]);

export function decodeDeploylessMulticall(data) {
    if (
        typeof data !== "string" ||
        !/^0x[0-9a-f]+$/i.test(data) ||
        !data
            .toLowerCase()
            .startsWith(deploylessCallViaBytecodeBytecode.toLowerCase())
    )
        throw new Error("Unknown deployless constructor bytecode");
    const normalized = data.toLowerCase();
    const decoded = decodeDeployData({
        abi: DEPLOYLESS_CONSTRUCTOR,
        bytecode: deploylessCallViaBytecodeBytecode,
        data: normalized,
    });
    const [code, calldata] = decoded.args;
    if (
        keccak256(code) !== DEPLOYLESS_MULTICALL3.creationCodeHash ||
        encodeDeployData({
            abi: DEPLOYLESS_CONSTRUCTOR,
            bytecode: deploylessCallViaBytecodeBytecode,
            args: decoded.args,
        }).toLowerCase() !== normalized
    )
        throw new Error(
            "Unsupported or malformed deployless Multicall3 creation code",
        );
    const aggregate = decodeFunctionData({
        abi: multicall3Abi,
        data: calldata,
    });
    if (
        aggregate.functionName !== DEPLOYLESS_MULTICALL3.functionName ||
        encodeFunctionData({
            abi: multicall3Abi,
            functionName: aggregate.functionName,
            args: aggregate.args,
        }).toLowerCase() !== calldata.toLowerCase()
    )
        throw new Error(
            "Unsupported or malformed deployless aggregate function",
        );
    const calls = aggregate.args[0];
    if (
        !Array.isArray(calls) ||
        calls.length < 1 ||
        calls.length > DEPLOYLESS_MULTICALL3.maximumCalls
    )
        throw new Error(
            "Deployless aggregate exceeds the explicit fixture call bound",
        );
    return calls;
}

/** Decode the contract leaves of an observed scalar or supported deployless
 * eth_call. This establishes request identity, never successful execution. */
export function decodeRpcContractCalls(request) {
    if (request?.method !== "eth_call")
        throw new Error("Contract call decoding requires an eth_call request");
    const transaction = request.params?.[0];
    if (
        !Array.isArray(request.params) ||
        !transaction ||
        typeof transaction !== "object" ||
        Array.isArray(transaction)
    )
        throw new Error("Contract call decoding requires a transaction object");
    const data = transaction.data ?? transaction.input;
    return transaction.to
        ? [{ target: transaction.to, ...decodeCall(data) }]
        : decodeDeploylessMulticall(data).map((call) => ({
              target: call.target,
              ...decodeCall(call.callData),
          }));
}

export function encodeDeploylessMulticallResult(results) {
    return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: DEPLOYLESS_MULTICALL3.functionName,
        result: results,
    });
}

/** Construct independently prepared marketplace inputs using EIP-712 wire types. */
export function prepareMarketOrder({ addresses, nowSeconds, side, tokenId }) {
    const maker = side === "sell" ? addresses.seller : addresses.bidder;
    const item = (itemType, token, identifier, amount) => ({
        itemType,
        token,
        identifierOrCriteria: BigInt(identifier),
        startAmount: BigInt(amount),
        endAmount: BigInt(amount),
    });
    const nft = item(2, addresses.nft, tokenId, 1);
    const money = item(1, addresses.weth, 0, 1_000_000_000_000_000_000n);
    const components = {
        offerer: maker,
        zone: ZERO_ADDRESS,
        offer: [side === "sell" ? nft : money],
        consideration: [
            { ...(side === "sell" ? money : nft), recipient: maker },
        ],
        orderType: 0,
        startTime: BigInt(nowSeconds - 3_600),
        endTime: BigInt(nowSeconds + 86_400),
        zoneHash: ZERO_HASH,
        salt: BigInt(tokenId),
        conduitKey: ZERO_HASH,
        counter: 0n,
    };
    const orderHash = hashStruct({
        data: components,
        primaryType: "OrderComponents",
        types: ORDER_TYPES,
    });
    return {
        side,
        tokenId: String(tokenId),
        orderHash,
        maker,
        components,
        raw: {
            status: "ACTIVE",
            order_hash: orderHash,
            chain: "ethereum",
            protocol_address: addresses.seaport,
            protocol_data: {
                parameters: jsonSafe({
                    ...components,
                    totalOriginalConsiderationItems:
                        components.consideration.length,
                }),
                // REST absence is intentional; this does not test signer recovery.
                signature: null,
            },
            price: {
                current: {
                    currency: "WETH",
                    decimals: 18,
                    value: money.startAmount.toString(),
                },
                value: money.startAmount.toString(),
            },
            remaining_quantity: 1,
            type: "basic",
            criteria: {},
        },
    };
}

/** Sign only synthetic fixture actors; signature failure is never papered over. */
export async function signMarketOrder(order, protocolAddress, chainId = 1) {
    const account = Object.values(WORLD_FIXTURE_ACCOUNTS).find(
        (candidate) =>
            candidate.address.toLowerCase() === order.maker.toLowerCase(),
    );
    if (!account)
        throw new Error("No public fixture key for marketplace maker");
    order.raw.protocol_data.signature = await account.signTypedData({
        domain: {
            name: "Seaport",
            version: "1.6",
            chainId,
            verifyingContract: protocolAddress,
        },
        primaryType: "OrderComponents",
        types: ORDER_TYPES,
        message: order.components,
    });
    return order;
}

/** SDK event callback payload, passed through the actual Phoenix transport. */
export function marketStreamEvent(
    order,
    addresses,
    collectionSlug,
    epochSeconds,
) {
    const eventType =
        order.side === "sell" ? "item_listed" : "item_received_offer";
    return {
        eventType,
        payload: {
            event_type: eventType,
            sent_at: new Date(epochSeconds * 1_000).toISOString(),
            payload: {
                order_hash: order.orderHash,
                protocol_address: addresses.seaport,
                protocol_data: order.raw.protocol_data,
                event_timestamp: new Date(epochSeconds * 1_000).toISOString(),
                expiration_date: new Date(
                    Number(order.components.endTime) * 1_000,
                ).toISOString(),
                base_price: "1000000000000000000",
                quantity: 1,
                maker: { address: order.maker },
                taker: null,
                payment_token: {
                    address: addresses.weth,
                    decimals: 18,
                    symbol: "WETH",
                },
                collection: { slug: collectionSlug },
                item: {
                    nft_id: `ethereum/${addresses.nft}/${order.tokenId}`,
                    chain: { name: "ethereum" },
                    permalink: `https://opensea.io/assets/ethereum/${addresses.nft}/${order.tokenId}`,
                },
            },
        },
    };
}

/** Explicit marketplace cancellation, separate from protocol fill/cancel state. */
export function marketCancellationEvent(
    order,
    addresses,
    collectionSlug,
    epochSeconds,
) {
    const event = marketStreamEvent(
        order,
        addresses,
        collectionSlug,
        epochSeconds,
    );
    event.eventType = "item_cancelled";
    event.payload.event_type = event.eventType;
    return event;
}

export function transferLog({ from, to, tokenId, address }) {
    return {
        address,
        topics: encodeEventTopics({
            abi: TRANSFER_ABI,
            eventName: "Transfer",
            args: { from, to, tokenId: BigInt(tokenId) },
        }),
        data: "0x",
    };
}

export function fulfilledLog(order, addresses) {
    return {
        address: addresses.seaport,
        topics: encodeEventTopics({
            abi: FULFILLED_ABI,
            eventName: "OrderFulfilled",
            args: { offerer: addresses.seller, zone: ZERO_ADDRESS },
        }),
        data: encodeAbiParameters(
            FULFILLED_ABI[0].inputs.filter((input) => !input.indexed),
            [
                order.orderHash,
                addresses.buyer,
                [
                    {
                        itemType: 2,
                        token: addresses.nft,
                        identifier: BigInt(order.tokenId),
                        amount: 1n,
                    },
                ],
                [
                    {
                        itemType: 1,
                        token: addresses.weth,
                        identifier: 0n,
                        amount: 1_000_000_000_000_000_000n,
                        recipient: addresses.seller,
                    },
                ],
            ],
        ),
    };
}

export function counterLog(offerer, address, newCounter) {
    return {
        address,
        topics: encodeEventTopics({
            abi: COUNTER_ABI,
            eventName: "CounterIncremented",
            args: { offerer },
        }),
        data: encodeAbiParameters([{ type: "uint256" }], [BigInt(newCounter)]),
    };
}
