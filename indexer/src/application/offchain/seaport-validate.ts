import {
    isSeaportProtocolStatus,
    type SeaportProtocolStatus,
} from "./seaport-status-reader.js";
import {
    partialBuyOriginalQuantity,
    fundedOrderQuantity,
    remainingOrderQuantity,
} from "../../domain/order-quantity.js";
import { zeroAddress } from "viem";
import { logger } from "@artgod/shared/utils";
import { ERC20_ABI, ERC721_APPROVAL_ABI } from "../../abi/index.js";
import { SEAPORT_VALIDATION_ABI as SEAPORT_ABI } from "../../abi/seaport-validation.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_STATUS,
    ORDER_SIDE,
    ORDER_VALIDATION_REASON,
    type OrderRecord,
    type OrderValidationReason,
    type OrderValidationResult,
    type SeaportOrderData,
} from "../../domain/orders.js";
import type { ConduitRegistryPort } from "../../ports/conduits.js";
import type { RpcProviderPort, Hex } from "../../ports/rpc.js";
import {
    asObject,
    assertAddress,
    assertString,
    toBigInt,
} from "@artgod/shared/offchain/normalizer-utils";
import {
    computeSeaportOrderHash,
    recoverSeaportSigner,
} from "./seaport-protocol.js";

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
): Promise<OrderValidationResult> {
    let parsed: ParsedProtocol | null = null;
    try {
        parsed = parseProtocolData(order.seaportData);
    } catch (error) {
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "parseProtocolData",
        });
        return invalidValidationResult(reason, error);
    }
    if (!parsed) {
        const reason = ORDER_VALIDATION_REASON.MissingProtocol;
        logInvalidValidation(order, reason, {
            phase: "parseProtocolData",
        });
        return invalidValidationResult(reason);
    }

    let orderHash: Hex;
    try {
        orderHash = computeSeaportOrderHash(order.seaportData!) as Hex;
    } catch (error) {
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logger.error("Seaport local order hash computation failed", {
            component: "SeaportOrderValidation",
            action: "validateSeaportOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "computeOrderHash",
        });
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "computeOrderHash",
        });
        return invalidValidationResult(reason, error);
    }

    if (orderHash.toLowerCase() !== order.id.toLowerCase()) {
        const reason = ORDER_VALIDATION_REASON.OrderHashMismatch;
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
                const reason = ORDER_VALIDATION_REASON.BadSignature;
                logInvalidValidation(order, reason, {
                    phase: "recoverTypedDataAddress",
                    recovered,
                });
                return invalidValidationResult(reason);
            }
        } catch (error) {
            const reason = ORDER_VALIDATION_REASON.SignatureError;
            logger.error("Seaport signature verification failed", {
                component: "SeaportOrderValidation",
                action: "validateSeaportOrder",
                chainId: order.chainId,
                orderId: order.id,
                error: String(error),
                phase: "recoverTypedDataAddress",
            });
            logInvalidValidation(order, reason, {
                error: String(error),
                phase: "recoverTypedDataAddress",
            });
            return invalidValidationResult(reason, error);
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
        return {
            status: ORDER_STATUS.Expired,
            reason: ORDER_VALIDATION_REASON.NotActive,
        };
    }
    if (now > Number(parsed.parameters.endTime)) {
        return {
            status: ORDER_STATUS.Expired,
            reason: ORDER_VALIDATION_REASON.Expired,
        };
    }

    let orderStatusResult: SeaportProtocolStatus | undefined;
    try {
        orderStatusResult = await rpc.readContract<SeaportProtocolStatus>({
            address: parsed.protocolAddress as Hex,
            abi: SEAPORT_ABI,
            functionName: "getOrderStatus",
            args: [orderHash as Hex],
        });
        if (!isSeaportProtocolStatus(orderStatusResult))
            throw new Error("Invalid Seaport order status response");
    } catch (error) {
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logger.error("Seaport getOrderStatus RPC failed", {
            component: "SeaportOrderValidation",
            action: "validateSeaportOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "getOrderStatus",
        });
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "getOrderStatus",
        });
        return invalidValidationResult(reason, error);
    }
    const [_isValidated, isCancelled, totalFilled, totalSize] =
        orderStatusResult;

    if (isCancelled) {
        return {
            status: ORDER_STATUS.Cancelled,
            reason: ORDER_VALIDATION_REASON.Cancelled,
        };
    }
    if (totalFilled >= totalSize && totalSize > 0n) {
        const original = partialBuyOriginalQuantity(order);
        return {
            status: ORDER_STATUS.Filled,
            reason: ORDER_VALIDATION_REASON.Filled,
            ...(original === null
                ? {}
                : {
                      quantities: {
                          original: original.toString(),
                          remaining: "0",
                          fillable: "0",
                      },
                  }),
        };
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
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logger.error("Seaport getCounter RPC failed", {
            component: "SeaportOrderValidation",
            action: "validateSeaportOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "getCounter",
        });
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "getCounter",
        });
        return invalidValidationResult(reason, error);
    }
    if (counter !== parsed.parameters.counter) {
        return {
            status: ORDER_STATUS.Cancelled,
            reason: ORDER_VALIDATION_REASON.CounterMismatch,
        };
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
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "resolveConduit",
            conduitKey: parsed.parameters.conduitKey,
        });
        return invalidValidationResult(reason, error);
    }
    if (!approvalTarget) {
        const reason = ORDER_VALIDATION_REASON.UnsupportedConduit;
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
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "ensureConduitChannel",
            approvalTarget,
            protocolAddress: parsed.protocolAddress,
        });
        return invalidValidationResult(reason, error);
    }
    if (!channelOk) {
        const reason = ORDER_VALIDATION_REASON.UnsupportedConduitChannel;
        logInvalidValidation(order, reason, {
            phase: "ensureConduitChannel",
            approvalTarget,
            protocolAddress: parsed.protocolAddress,
        });
        return invalidValidationResult(reason);
    }

    const price = order.price ? BigInt(order.price) : null;
    if (!price || price <= 0n) {
        const reason = ORDER_VALIDATION_REASON.MissingPrice;
        logInvalidValidation(order, reason, {
            phase: "priceCheck",
            price: order.price,
        });
        return invalidValidationResult(reason);
    }

    if (order.side === ORDER_SIDE.Sell) {
        return validateSellOrder(rpc, order, approvalTarget);
    }

    if (order.side === ORDER_SIDE.Buy) {
        const original = partialBuyOriginalQuantity(order);
        let remaining: bigint | null = null;
        if (original !== null) {
            try {
                remaining = remainingOrderQuantity(
                    original,
                    totalFilled,
                    totalSize,
                );
            } catch {
                return invalidValidationResult(
                    ORDER_VALIDATION_REASON.InvalidFillFraction,
                );
            }
        }
        const { capacity, ...result } = await validateBuyOrder(
            rpc,
            order,
            approvalTarget,
            price,
            remaining,
        );
        return original !== null && remaining !== null && capacity !== undefined
            ? {
                  ...result,
                  quantities: {
                      original: original.toString(),
                      remaining: remaining.toString(),
                      fillable: capacity.toString(),
                  },
              }
            : result;
    }

    const reason = ORDER_VALIDATION_REASON.UnknownSide;
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
): Promise<OrderValidationResult> {
    if (!order.tokenId) {
        const reason = ORDER_VALIDATION_REASON.MissingTokenId;
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
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logger.error("Seaport sell order owner lookup failed", {
            component: "SeaportOrderValidation",
            action: "validateSellOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "ownerOf",
        });
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "ownerOf",
        });
        return invalidValidationResult(reason, error);
    }
    if (owner.toLowerCase() !== order.maker.toLowerCase()) {
        return {
            status: ORDER_STATUS.NoBalance,
            reason: ORDER_VALIDATION_REASON.OwnerMismatch,
        };
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
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logger.error("Seaport sell order approval-for-all lookup failed", {
            component: "SeaportOrderValidation",
            action: "validateSellOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "isApprovedForAll",
        });
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "isApprovedForAll",
        });
        return invalidValidationResult(reason, error);
    }
    if (approvedForAll) {
        return {
            status: ORDER_STATUS.Fillable,
            reason: ORDER_VALIDATION_REASON.Approved,
        };
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
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logger.error("Seaport sell order approval lookup failed", {
            component: "SeaportOrderValidation",
            action: "validateSellOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "getApproved",
        });
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "getApproved",
        });
        return invalidValidationResult(reason, error);
    }
    if (approved.toLowerCase() === approvalTarget.toLowerCase()) {
        return {
            status: ORDER_STATUS.Fillable,
            reason: ORDER_VALIDATION_REASON.Approved,
        };
    }

    return {
        status: ORDER_STATUS.NoApproval,
        reason: ORDER_VALIDATION_REASON.MissingApproval,
    };
}

async function validateBuyOrder(
    rpc: RpcProviderPort,
    order: OrderRecord,
    approvalTarget: string,
    price: bigint,
    remaining: bigint | null,
): Promise<OrderValidationResult & { capacity?: bigint }> {
    const currency = order.currency ?? zeroAddress;
    if (currency.toLowerCase() === zeroAddress.toLowerCase()) {
        let balance: bigint;
        try {
            balance = await rpc.getBalance(order.maker as Hex);
        } catch (error) {
            const reason = ORDER_VALIDATION_REASON.ProtocolError;
            logger.error("Seaport buy order native balance lookup failed", {
                component: "SeaportOrderValidation",
                action: "validateBuyOrder",
                chainId: order.chainId,
                orderId: order.id,
                error: String(error),
                phase: "getBalance",
            });
            logInvalidValidation(order, reason, {
                error: String(error),
                phase: "getBalance",
            });
            return invalidValidationResult(reason, error);
        }
        if (balance < price) {
            return {
                status: ORDER_STATUS.NoBalance,
                reason: ORDER_VALIDATION_REASON.NoBalance,
                capacity: 0n,
            };
        }
        return {
            status: ORDER_STATUS.Fillable,
            reason: ORDER_VALIDATION_REASON.NativeFundsAvailable,
            capacity:
                remaining === null
                    ? undefined
                    : fundedOrderQuantity(remaining, price, balance),
        };
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
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logger.error("Seaport buy order allowance lookup failed", {
            component: "SeaportOrderValidation",
            action: "validateBuyOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "allowance",
        });
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "allowance",
        });
        return invalidValidationResult(reason, error);
    }
    if (allowance < price) {
        return {
            status: ORDER_STATUS.NoApproval,
            reason: ORDER_VALIDATION_REASON.NoAllowance,
            capacity: 0n,
        };
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
        const reason = ORDER_VALIDATION_REASON.ProtocolError;
        logger.error("Seaport buy order ERC20 balance lookup failed", {
            component: "SeaportOrderValidation",
            action: "validateBuyOrder",
            chainId: order.chainId,
            orderId: order.id,
            error: String(error),
            phase: "balanceOf",
        });
        logInvalidValidation(order, reason, {
            error: String(error),
            phase: "balanceOf",
        });
        return invalidValidationResult(reason, error);
    }
    if (balance < price) {
        return {
            status: ORDER_STATUS.NoBalance,
            reason: ORDER_VALIDATION_REASON.NoBalance,
            capacity: 0n,
        };
    }

    return {
        status: ORDER_STATUS.Fillable,
        reason: ORDER_VALIDATION_REASON.Erc20FundsAvailable,
        capacity:
            remaining === null
                ? undefined
                : fundedOrderQuantity(remaining, price, balance, allowance),
    };
}

function logInvalidValidation(
    order: OrderRecord,
    reason: OrderValidationReason,
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
    reason: OrderValidationReason,
    error?: unknown,
): OrderValidationResult {
    return {
        status: ORDER_STATUS.Invalid,
        reason,
        ...(error === undefined ? {} : { error: String(error) }),
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
