import { recoverAddress, zeroAddress } from "viem";
import { ERC20_ABI, ERC721_APPROVAL_ABI } from "../../abi/index.js";
import { ORDER_STATUS, type OrderStatus } from "../../domain/orders.js";
import type { OrderRecord } from "../../domain/orders.js";
import type { ConduitRegistryPort } from "../../ports/conduits.js";
import type { RpcProviderPort, Hex } from "../../ports/rpc.js";
import {
    asObject,
    assertAddress,
    assertString,
    toBigInt,
} from "./normalizer-utils.js";

const SEAPORT_ABI = [
    {
        type: "function",
        name: "getOrderHash",
        inputs: [
            {
                name: "order",
                type: "tuple",
                components: [
                    { name: "offerer", type: "address" },
                    { name: "zone", type: "address" },
                    {
                        name: "offer",
                        type: "tuple[]",
                        components: [
                            { name: "itemType", type: "uint8" },
                            { name: "token", type: "address" },
                            { name: "identifierOrCriteria", type: "uint256" },
                            { name: "startAmount", type: "uint256" },
                            { name: "endAmount", type: "uint256" },
                        ],
                    },
                    {
                        name: "consideration",
                        type: "tuple[]",
                        components: [
                            { name: "itemType", type: "uint8" },
                            { name: "token", type: "address" },
                            { name: "identifierOrCriteria", type: "uint256" },
                            { name: "startAmount", type: "uint256" },
                            { name: "endAmount", type: "uint256" },
                            { name: "recipient", type: "address" },
                        ],
                    },
                    { name: "orderType", type: "uint8" },
                    { name: "startTime", type: "uint256" },
                    { name: "endTime", type: "uint256" },
                    { name: "zoneHash", type: "bytes32" },
                    { name: "salt", type: "uint256" },
                    { name: "conduitKey", type: "bytes32" },
                    {
                        name: "totalOriginalConsiderationItems",
                        type: "uint256",
                    },
                    { name: "counter", type: "uint256" },
                ],
            },
        ],
        outputs: [{ name: "orderHash", type: "bytes32" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getOrderStatus",
        inputs: [{ name: "orderHash", type: "bytes32" }],
        outputs: [
            { name: "isValidated", type: "bool" },
            { name: "isCancelled", type: "bool" },
            { name: "totalFilled", type: "uint256" },
            { name: "totalSize", type: "uint256" },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getCounter",
        inputs: [{ name: "offerer", type: "address" }],
        outputs: [{ name: "counter", type: "uint256" }],
        stateMutability: "view",
    },
] as const;

const CONDUIT_CONTROLLER_ABI = [
    {
        type: "function",
        name: "getConduit",
        inputs: [{ name: "conduitKey", type: "bytes32" }],
        outputs: [
            { name: "conduit", type: "address" },
            { name: "exists", type: "bool" },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getChannels",
        inputs: [{ name: "conduit", type: "address" }],
        outputs: [{ name: "channels", type: "address[]" }],
        stateMutability: "view",
    },
] as const;

const ZERO_BYTES32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

type SeaportValidationConfig = {
    conduitController: string;
};

type OrderParameters = {
    offerer: string;
    zone: string;
    offer: OfferItem[];
    consideration: ConsiderationItem[];
    orderType: bigint;
    startTime: bigint;
    endTime: bigint;
    zoneHash: string;
    salt: bigint;
    conduitKey: string;
    totalOriginalConsiderationItems: bigint;
    counter: bigint;
};

type OfferItem = {
    itemType: bigint;
    token: string;
    identifierOrCriteria: bigint;
    startAmount: bigint;
    endAmount: bigint;
};

type ConsiderationItem = OfferItem & { recipient: string };

type ParsedProtocol = {
    protocolAddress: string;
    orderHash: string;
    signature: string;
    parameters: OrderParameters;
};

export async function validateSeaportOrder(
    rpc: RpcProviderPort,
    conduits: ConduitRegistryPort,
    config: SeaportValidationConfig,
    order: OrderRecord,
): Promise<{ status: OrderStatus; reason: string }> {
    let parsed: ParsedProtocol | null = null;
    try {
        parsed = parseProtocolData(order.rawData);
    } catch (error) {
        return {
            status: ORDER_STATUS.Invalid,
            reason: `protocol-error:${String(error)}`,
        };
    }
    if (!parsed) {
        return { status: ORDER_STATUS.Invalid, reason: "missing-protocol" };
    }

    if (parsed.orderHash.toLowerCase() !== order.id.toLowerCase()) {
        return { status: ORDER_STATUS.Invalid, reason: "hash-mismatch" };
    }

    const orderHash = await rpc.readContract<string>({
        address: parsed.protocolAddress as Hex,
        abi: SEAPORT_ABI,
        functionName: "getOrderHash",
        args: [toOrderComponents(parsed.parameters)],
    });

    if (orderHash.toLowerCase() !== order.id.toLowerCase()) {
        return { status: ORDER_STATUS.Invalid, reason: "hash-mismatch" };
    }

    const recovered = await recoverAddress({
        hash: orderHash as Hex,
        signature: parsed.signature as Hex,
    });
    if (recovered.toLowerCase() !== order.maker.toLowerCase()) {
        return { status: ORDER_STATUS.Invalid, reason: "bad-signature" };
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < Number(parsed.parameters.startTime)) {
        return { status: ORDER_STATUS.Expired, reason: "not-active" };
    }
    if (now > Number(parsed.parameters.endTime)) {
        return { status: ORDER_STATUS.Expired, reason: "expired" };
    }

    const [_isValidated, isCancelled, totalFilled, totalSize] =
        (await rpc.readContract<readonly [boolean, boolean, bigint, bigint]>({
            address: parsed.protocolAddress as Hex,
            abi: SEAPORT_ABI,
            functionName: "getOrderStatus",
            args: [orderHash as Hex],
        })) ?? [false, false, 0n, 1n];

    if (isCancelled) {
        return { status: ORDER_STATUS.Cancelled, reason: "cancelled" };
    }
    if (totalFilled >= totalSize && totalSize > 0n) {
        return { status: ORDER_STATUS.Filled, reason: "filled" };
    }

    const counter = await rpc.readContract<bigint>({
        address: parsed.protocolAddress as Hex,
        abi: SEAPORT_ABI,
        functionName: "getCounter",
        args: [parsed.parameters.offerer as Hex],
    });
    if (counter !== parsed.parameters.counter) {
        return { status: ORDER_STATUS.Cancelled, reason: "counter-mismatch" };
    }

    const approvalTarget = await resolveConduit(
        rpc,
        conduits,
        config.conduitController,
        order.chainId,
        parsed.protocolAddress,
        parsed.parameters.conduitKey,
    );
    if (!approvalTarget) {
        return { status: ORDER_STATUS.Invalid, reason: "unsupported-conduit" };
    }

    const channelOk = await ensureConduitChannel(
        rpc,
        conduits,
        config.conduitController,
        order.chainId,
        approvalTarget,
        parsed.protocolAddress,
    );
    if (!channelOk) {
        return {
            status: ORDER_STATUS.Invalid,
            reason: "unsupported-conduit-channel",
        };
    }

    const price = order.price ? BigInt(order.price) : null;
    if (!price || price <= 0n) {
        return { status: ORDER_STATUS.Invalid, reason: "missing-price" };
    }

    if (order.side === "sell") {
        return validateSellOrder(rpc, order, approvalTarget);
    }

    if (order.side === "buy") {
        return validateBuyOrder(rpc, order, approvalTarget, price);
    }

    return { status: ORDER_STATUS.Invalid, reason: "unknown-side" };
}

async function validateSellOrder(
    rpc: RpcProviderPort,
    order: OrderRecord,
    approvalTarget: string,
): Promise<{ status: OrderStatus; reason: string }> {
    const owner = await rpc.readContract<string>({
        address: order.contract as Hex,
        abi: ERC721_APPROVAL_ABI,
        functionName: "ownerOf",
        args: [BigInt(order.tokenId)],
    });
    if (owner.toLowerCase() !== order.maker.toLowerCase()) {
        return { status: ORDER_STATUS.NoBalance, reason: "owner-mismatch" };
    }

    const approvedForAll = await rpc.readContract<boolean>({
        address: order.contract as Hex,
        abi: ERC721_APPROVAL_ABI,
        functionName: "isApprovedForAll",
        args: [order.maker as Hex, approvalTarget as Hex],
    });
    if (approvedForAll) {
        return { status: ORDER_STATUS.Fillable, reason: "approved" };
    }

    const approved = await rpc.readContract<string>({
        address: order.contract as Hex,
        abi: ERC721_APPROVAL_ABI,
        functionName: "getApproved",
        args: [BigInt(order.tokenId)],
    });
    if (approved.toLowerCase() === approvalTarget.toLowerCase()) {
        return { status: ORDER_STATUS.Fillable, reason: "approved" };
    }

    return { status: ORDER_STATUS.NoApproval, reason: "missing-approval" };
}

async function validateBuyOrder(
    rpc: RpcProviderPort,
    order: OrderRecord,
    approvalTarget: string,
    price: bigint,
): Promise<{ status: OrderStatus; reason: string }> {
    const currency = order.currency ?? zeroAddress;
    if (currency.toLowerCase() === zeroAddress.toLowerCase()) {
        const balance = await rpc.getBalance(order.maker as Hex);
        if (balance < price) {
            return { status: ORDER_STATUS.NoBalance, reason: "no-balance" };
        }
        return { status: ORDER_STATUS.Fillable, reason: "native-ok" };
    }

    const allowance = await rpc.readContract<bigint>({
        address: currency as Hex,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [order.maker as Hex, approvalTarget as Hex],
    });
    if (allowance < price) {
        return { status: ORDER_STATUS.NoApproval, reason: "no-allowance" };
    }

    const balance = await rpc.readContract<bigint>({
        address: currency as Hex,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [order.maker as Hex],
    });
    if (balance < price) {
        return { status: ORDER_STATUS.NoBalance, reason: "no-balance" };
    }

    return { status: ORDER_STATUS.Fillable, reason: "erc20-ok" };
}

async function resolveConduit(
    rpc: RpcProviderPort,
    conduits: ConduitRegistryPort,
    conduitController: string,
    chainId: number,
    seaportAddress: string,
    conduitKey: string,
): Promise<string | null> {
    if (!conduitKey || conduitKey.toLowerCase() === ZERO_BYTES32) {
        return seaportAddress.toLowerCase();
    }

    const cached = conduits.getConduit(chainId, conduitKey);
    if (cached) return cached;

    const result = await rpc.readContract<readonly [string, boolean]>({
        address: conduitController as Hex,
        abi: CONDUIT_CONTROLLER_ABI,
        functionName: "getConduit",
        args: [conduitKey as Hex],
    });
    const conduit = result?.[0];
    const exists = result?.[1];
    if (!conduit || !exists) {
        return null;
    }

    conduits.upsertConduit({
        chainId,
        conduitKey,
        conduitAddress: conduit,
    });
    return conduit.toLowerCase();
}

async function ensureConduitChannel(
    rpc: RpcProviderPort,
    conduits: ConduitRegistryPort,
    conduitController: string,
    chainId: number,
    conduitAddress: string,
    channelAddress: string,
): Promise<boolean> {
    if (conduitAddress.toLowerCase() === channelAddress.toLowerCase()) {
        return true;
    }
    if (conduits.hasChannel(chainId, conduitAddress, channelAddress)) {
        return true;
    }

    const channels = await rpc.readContract<string[]>({
        address: conduitController as Hex,
        abi: CONDUIT_CONTROLLER_ABI,
        functionName: "getChannels",
        args: [conduitAddress as Hex],
    });

    const normalized = (channels ?? []).map((value) => value.toLowerCase());
    conduits.replaceChannels(chainId, conduitAddress, normalized);
    return normalized.includes(channelAddress.toLowerCase());
}

function parseProtocolData(
    rawData: string | null | undefined,
): ParsedProtocol | null {
    if (!rawData) return null;
    const parsed = JSON.parse(rawData) as unknown;
    const envelope = asObject(parsed, "rawData");
    const payload = asObject(envelope.payload, "payload");
    const protocolAddress = assertAddress(
        payload.protocol_address,
        "protocol_address",
    );
    const orderHash = assertString(payload.order_hash, "order_hash");
    const protocolData = asObject(payload.protocol_data, "protocol_data");
    const parameters = asObject(
        protocolData.parameters,
        "protocol_data.parameters",
    );
    const signature = assertString(
        protocolData.signature,
        "protocol_data.signature",
    );

    return {
        protocolAddress,
        orderHash,
        signature,
        parameters: parseOrderParameters(parameters),
    };
}

function parseOrderParameters(raw: Record<string, unknown>): OrderParameters {
    const offer = parseItems(raw.offer, false);
    const consideration = parseItems(
        raw.consideration,
        true,
    ) as ConsiderationItem[];

    return {
        offerer: assertAddress(raw.offerer, "offerer"),
        zone: assertAddress(raw.zone, "zone"),
        offer,
        consideration,
        orderType: toBigInt(raw.orderType, "orderType"),
        startTime: toBigInt(raw.startTime, "startTime"),
        endTime: toBigInt(raw.endTime, "endTime"),
        zoneHash: assertString(raw.zoneHash, "zoneHash"),
        salt: toBigInt(raw.salt, "salt"),
        conduitKey: assertString(raw.conduitKey, "conduitKey"),
        totalOriginalConsiderationItems: toBigInt(
            raw.totalOriginalConsiderationItems,
            "totalOriginalConsiderationItems",
        ),
        counter: toBigInt(raw.counter, "counter"),
    };
}

function parseItems(value: unknown, withRecipient: boolean): OfferItem[] {
    if (!Array.isArray(value)) {
        throw new Error("Invalid items: expected array");
    }
    return value.map((entry, index) => {
        const item = asObject(entry, `item[${index}]`);
        const base: OfferItem = {
            itemType: toBigInt(item.itemType, "itemType"),
            token: assertAddress(item.token, "token"),
            identifierOrCriteria: toBigInt(
                item.identifierOrCriteria,
                "identifierOrCriteria",
            ),
            startAmount: toBigInt(item.startAmount, "startAmount"),
            endAmount: toBigInt(item.endAmount, "endAmount"),
        };
        if (withRecipient) {
            return {
                ...base,
                recipient: assertAddress(item.recipient, "recipient"),
            } as ConsiderationItem;
        }
        return base;
    });
}

function toOrderComponents(params: OrderParameters): unknown {
    return {
        offerer: params.offerer,
        zone: params.zone,
        offer: params.offer.map((item) => ({
            itemType: Number(item.itemType),
            token: item.token,
            identifierOrCriteria: item.identifierOrCriteria,
            startAmount: item.startAmount,
            endAmount: item.endAmount,
        })),
        consideration: params.consideration.map((item) => ({
            itemType: Number(item.itemType),
            token: item.token,
            identifierOrCriteria: item.identifierOrCriteria,
            startAmount: item.startAmount,
            endAmount: item.endAmount,
            recipient: item.recipient,
        })),
        orderType: Number(params.orderType),
        startTime: params.startTime,
        endTime: params.endTime,
        zoneHash: params.zoneHash,
        salt: params.salt,
        conduitKey: params.conduitKey,
        totalOriginalConsiderationItems: params.totalOriginalConsiderationItems,
        counter: params.counter,
    };
}
