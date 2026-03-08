import { zeroAddress } from "viem";
import { logger } from "@artgod/shared/utils";
import { ERC20_ABI, ERC721_APPROVAL_ABI } from "../../abi/index.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_STATUS,
    type OrderStatus,
    type SeaportOrderData,
} from "../../domain/orders.js";
import type { OrderRecord } from "../../domain/orders.js";
import type { ConduitRegistryPort } from "../../ports/conduits.js";
import type { RpcProviderPort, Hex } from "../../ports/rpc.js";
import {
    asObject,
    assertAddress,
    assertString,
    toBigInt,
} from "./normalizer-utils.js";
import {
    computeSeaportOrderHash,
    recoverSeaportSigner,
} from "./seaport-protocol.js";

const SEAPORT_ABI = [
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
    signature: string | null;
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
        parsed = parseProtocolData(order.seaportData);
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logInvalidValidation(order, reason, {
            phase: "parseProtocolData",
        });
        return invalidValidationResult(reason);
    }
    if (!parsed) {
        const reason = "missing-protocol";
        logInvalidValidation(order, reason, {
            phase: "parseProtocolData",
        });
        return invalidValidationResult(reason);
    }

    let orderHash: Hex;
    try {
        orderHash = computeSeaportOrderHash(order.seaportData!) as Hex;
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logger.error("Seaport local order hash computation failed", {
            component: "SeaportOrderValidation",
            action: "validateSeaportOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "computeOrderHash",
        });
        logInvalidValidation(order, reason, {
            phase: "computeOrderHash",
        });
        return invalidValidationResult(reason);
    }

    if (orderHash.toLowerCase() !== order.id.toLowerCase()) {
        const reason = "order-hash-mismatch";
        logInvalidValidation(order, reason, {
            phase: "compareOrderHash",
            computedOrderHash: orderHash,
        });
        return invalidValidationResult(reason);
    }

    if (parsed.signature) {
        try {
            const recovered = await recoverSeaportSigner(
                order.chainId,
                order.seaportData!,
            );
            if (recovered.toLowerCase() !== order.maker.toLowerCase()) {
                const reason = "bad-signature";
                logInvalidValidation(order, reason, {
                    phase: "recoverTypedDataAddress",
                    recovered,
                });
                return invalidValidationResult(reason);
            }
        } catch (error) {
            const reason = `signature-error:${String(error)}`;
            logger.error("Seaport signature verification failed", {
                component: "SeaportOrderValidation",
                action: "validateSeaportOrder",
                chainId: order.chainId,
                orderId: order.id,
                error: String(error),
                phase: "recoverTypedDataAddress",
            });
            logInvalidValidation(order, reason, {
                phase: "recoverTypedDataAddress",
            });
            return invalidValidationResult(reason);
        }
    } else if (
        order.seaportDataSourceKind === ORDER_SEAPORT_DATA_SOURCE_KIND.Stream
    ) {
        logger.warn("Seaport stream order missing signature", {
            component: "SeaportOrderValidation",
            action: "validateSeaportOrder",
            chainId: order.chainId,
            orderId: order.id,
            phase: "recoverTypedDataAddress",
        });
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < Number(parsed.parameters.startTime)) {
        return { status: ORDER_STATUS.Expired, reason: "not-active" };
    }
    if (now > Number(parsed.parameters.endTime)) {
        return { status: ORDER_STATUS.Expired, reason: "expired" };
    }

    let orderStatusResult:
        | readonly [boolean, boolean, bigint, bigint]
        | undefined;
    try {
        orderStatusResult =
            (await rpc.readContract<readonly [boolean, boolean, bigint, bigint]>({
                address: parsed.protocolAddress as Hex,
                abi: SEAPORT_ABI,
                functionName: "getOrderStatus",
                args: [orderHash as Hex],
            })) ?? [false, false, 0n, 1n];
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logger.error("Seaport getOrderStatus RPC failed", {
            component: "SeaportOrderValidation",
            action: "validateSeaportOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "getOrderStatus",
        });
        logInvalidValidation(order, reason, {
            phase: "getOrderStatus",
        });
        return invalidValidationResult(reason);
    }
    const [_isValidated, isCancelled, totalFilled, totalSize] =
        orderStatusResult;

    if (isCancelled) {
        return { status: ORDER_STATUS.Cancelled, reason: "cancelled" };
    }
    if (totalFilled >= totalSize && totalSize > 0n) {
        return { status: ORDER_STATUS.Filled, reason: "filled" };
    }

    let counter: bigint;
    try {
        counter = await rpc.readContract<bigint>({
            address: parsed.protocolAddress as Hex,
            abi: SEAPORT_ABI,
            functionName: "getCounter",
            args: [parsed.parameters.offerer as Hex],
        });
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logger.error("Seaport getCounter RPC failed", {
            component: "SeaportOrderValidation",
            action: "validateSeaportOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "getCounter",
        });
        logInvalidValidation(order, reason, {
            phase: "getCounter",
        });
        return invalidValidationResult(reason);
    }
    if (counter !== parsed.parameters.counter) {
        return { status: ORDER_STATUS.Cancelled, reason: "counter-mismatch" };
    }

    let approvalTarget: string | null;
    try {
        approvalTarget = await resolveConduit(
            rpc,
            conduits,
            config.conduitController,
            order.chainId,
            order.id,
            parsed.protocolAddress,
            parsed.parameters.conduitKey,
        );
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logInvalidValidation(order, reason, {
            phase: "resolveConduit",
            conduitKey: parsed.parameters.conduitKey,
        });
        return invalidValidationResult(reason);
    }
    if (!approvalTarget) {
        const reason = "unsupported-conduit";
        logInvalidValidation(order, reason, {
            phase: "resolveConduit",
            conduitKey: parsed.parameters.conduitKey,
        });
        return invalidValidationResult(reason);
    }

    let channelOk = false;
    try {
        channelOk = await ensureConduitChannel(
            rpc,
            conduits,
            config.conduitController,
            order.chainId,
            order.id,
            approvalTarget,
            parsed.protocolAddress,
        );
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logInvalidValidation(order, reason, {
            phase: "ensureConduitChannel",
            approvalTarget,
            protocolAddress: parsed.protocolAddress,
        });
        return invalidValidationResult(reason);
    }
    if (!channelOk) {
        const reason = "unsupported-conduit-channel";
        logInvalidValidation(order, reason, {
            phase: "ensureConduitChannel",
            approvalTarget,
            protocolAddress: parsed.protocolAddress,
        });
        return invalidValidationResult(reason);
    }

    const price = order.price ? BigInt(order.price) : null;
    if (!price || price <= 0n) {
        const reason = "missing-price";
        logInvalidValidation(order, reason, {
            phase: "priceCheck",
            price: order.price,
        });
        return invalidValidationResult(reason);
    }

    if (order.side === "sell") {
        return validateSellOrder(rpc, order, approvalTarget);
    }

    if (order.side === "buy") {
        return validateBuyOrder(rpc, order, approvalTarget, price);
    }

    const reason = "unknown-side";
    logInvalidValidation(order, reason, {
        phase: "sideCheck",
        side: order.side,
    });
    return invalidValidationResult(reason);
}

async function validateSellOrder(
    rpc: RpcProviderPort,
    order: OrderRecord,
    approvalTarget: string,
): Promise<{ status: OrderStatus; reason: string }> {
    if (!order.tokenId) {
        const reason = "missing-token-id";
        logInvalidValidation(order, reason, {
            phase: "sellTokenCheck",
        });
        return invalidValidationResult(reason);
    }
    let owner: string;
    try {
        owner = await rpc.readContract<string>({
            address: order.contract as Hex,
            abi: ERC721_APPROVAL_ABI,
            functionName: "ownerOf",
            args: [BigInt(order.tokenId)],
        });
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logger.error("Seaport sell order owner lookup failed", {
            component: "SeaportOrderValidation",
            action: "validateSellOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "ownerOf",
        });
        logInvalidValidation(order, reason, {
            phase: "ownerOf",
        });
        return invalidValidationResult(reason);
    }
    if (owner.toLowerCase() !== order.maker.toLowerCase()) {
        return { status: ORDER_STATUS.NoBalance, reason: "owner-mismatch" };
    }

    let approvedForAll = false;
    try {
        approvedForAll = await rpc.readContract<boolean>({
            address: order.contract as Hex,
            abi: ERC721_APPROVAL_ABI,
            functionName: "isApprovedForAll",
            args: [order.maker as Hex, approvalTarget as Hex],
        });
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logger.error("Seaport sell order approval-for-all lookup failed", {
            component: "SeaportOrderValidation",
            action: "validateSellOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "isApprovedForAll",
        });
        logInvalidValidation(order, reason, {
            phase: "isApprovedForAll",
        });
        return invalidValidationResult(reason);
    }
    if (approvedForAll) {
        return { status: ORDER_STATUS.Fillable, reason: "approved" };
    }

    let approved: string;
    try {
        approved = await rpc.readContract<string>({
            address: order.contract as Hex,
            abi: ERC721_APPROVAL_ABI,
            functionName: "getApproved",
            args: [BigInt(order.tokenId)],
        });
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logger.error("Seaport sell order approval lookup failed", {
            component: "SeaportOrderValidation",
            action: "validateSellOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "getApproved",
        });
        logInvalidValidation(order, reason, {
            phase: "getApproved",
        });
        return invalidValidationResult(reason);
    }
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
        let balance: bigint;
        try {
            balance = await rpc.getBalance(order.maker as Hex);
        } catch (error) {
            const reason = `protocol-error:${String(error)}`;
            logger.error("Seaport buy order native balance lookup failed", {
                component: "SeaportOrderValidation",
                action: "validateBuyOrder",
                chainId: order.chainId,
                orderId: order.id,
                error: String(error),
                phase: "getBalance",
            });
            logInvalidValidation(order, reason, {
                phase: "getBalance",
            });
            return invalidValidationResult(reason);
        }
        if (balance < price) {
            return { status: ORDER_STATUS.NoBalance, reason: "no-balance" };
        }
        return { status: ORDER_STATUS.Fillable, reason: "native-ok" };
    }

    let allowance: bigint;
    try {
        allowance = await rpc.readContract<bigint>({
            address: currency as Hex,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [order.maker as Hex, approvalTarget as Hex],
        });
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logger.error("Seaport buy order allowance lookup failed", {
            component: "SeaportOrderValidation",
            action: "validateBuyOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "allowance",
        });
        logInvalidValidation(order, reason, {
            phase: "allowance",
        });
        return invalidValidationResult(reason);
    }
    if (allowance < price) {
        return { status: ORDER_STATUS.NoApproval, reason: "no-allowance" };
    }

    let balance: bigint;
    try {
        balance = await rpc.readContract<bigint>({
            address: currency as Hex,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [order.maker as Hex],
        });
    } catch (error) {
        const reason = `protocol-error:${String(error)}`;
        logger.error("Seaport buy order ERC20 balance lookup failed", {
            component: "SeaportOrderValidation",
            action: "validateBuyOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "balanceOf",
        });
        logInvalidValidation(order, reason, {
            phase: "balanceOf",
        });
        return invalidValidationResult(reason);
    }
    if (balance < price) {
        return { status: ORDER_STATUS.NoBalance, reason: "no-balance" };
    }

    return { status: ORDER_STATUS.Fillable, reason: "erc20-ok" };
}

function logInvalidValidation(
    order: OrderRecord,
    reason: string,
    details: Record<string, unknown> = {},
): void {
    logger.debug("Seaport order validation marked order invalid", {
        component: "SeaportOrderValidation",
        action: "validateSeaportOrder",
        chainId: order.chainId,
        orderId: order.id,
        reason,
        order,
        ...details,
    });
}

function invalidValidationResult(
    reason: string,
): { status: OrderStatus; reason: string } {
    return {
        status: ORDER_STATUS.Invalid,
        reason,
    };
}

async function resolveConduit(
    rpc: RpcProviderPort,
    conduits: ConduitRegistryPort,
    conduitController: string,
    chainId: number,
    orderId: string,
    seaportAddress: string,
    conduitKey: string,
): Promise<string | null> {
    if (!conduitKey || conduitKey.toLowerCase() === ZERO_BYTES32) {
        return seaportAddress.toLowerCase();
    }

    const cached = conduits.getConduit(chainId, conduitKey);
    if (cached) {
        return cached;
    }

    try {
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

        const normalizedConduit = conduit.toLowerCase();
        return normalizedConduit;
    } catch (error) {
        logger.error("Seaport conduit resolution failed", {
            component: "SeaportOrderValidation",
            action: "conduitValidation",
            chainId,
            orderId,
            conduitController,
            conduitKey,
            error: String(error),
        });
        throw error;
    }
}

async function ensureConduitChannel(
    rpc: RpcProviderPort,
    conduits: ConduitRegistryPort,
    conduitController: string,
    chainId: number,
    orderId: string,
    conduitAddress: string,
    channelAddress: string,
): Promise<boolean> {
    if (conduitAddress.toLowerCase() === channelAddress.toLowerCase()) {
        return true;
    }

    if (conduits.hasChannel(chainId, conduitAddress, channelAddress)) {
        return true;
    }

    try {
        const channels = await rpc.readContract<string[]>({
            address: conduitController as Hex,
            abi: CONDUIT_CONTROLLER_ABI,
            functionName: "getChannels",
            args: [conduitAddress as Hex],
        });

        const normalized = (channels ?? []).map((value) => value.toLowerCase());

        conduits.replaceChannels(chainId, conduitAddress, normalized);

        const supported = normalized.includes(channelAddress.toLowerCase());
        return supported;
    } catch (error) {
        logger.error("Seaport conduit channel resolution failed", {
            component: "SeaportOrderValidation",
            action: "conduitValidation",
            chainId,
            orderId,
            conduitController,
            conduitAddress,
            channelAddress,
            error: String(error),
        });
        throw error;
    }
}

function parseProtocolData(
    seaportData: SeaportOrderData | null | undefined,
): ParsedProtocol | null {
    if (!seaportData) return null;

    return {
        protocolAddress: assertAddress(
            seaportData.protocolAddress,
            "seaportData.protocolAddress",
        ),
        signature: seaportData.signature,
        parameters: parseOrderParameters(seaportData),
    };
}

function parseOrderParameters(raw: SeaportOrderData): OrderParameters {
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
