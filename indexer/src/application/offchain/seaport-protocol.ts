import {
    concatHex,
    getAddress,
    keccak256,
    recoverTypedDataAddress,
    stringToBytes,
    toHex,
    type Hex,
} from "viem";
import type { SeaportOrderData } from "../../domain/orders.js";

const SEAPORT_CONTRACT_NAME = "Seaport";
const SEAPORT_VERSION_V1_6 = "1.6";
const SEAPORT_V1_6_PROTOCOL_ADDRESSES = new Map<string, string>([
    [
        getAddress("0x0000000000000068F116a894984e2DB1123eB395"),
        SEAPORT_VERSION_V1_6,
    ],
    [
        getAddress("0x00000000006687982678b03100B9bDC8be440814"),
        SEAPORT_VERSION_V1_6,
    ],
]);

const EIP_712_ORDER_TYPE = {
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
} as const;

type SeaportOfferItem = {
    itemType: number;
    token: Hex;
    identifierOrCriteria: bigint;
    startAmount: bigint;
    endAmount: bigint;
};

type SeaportConsiderationItem = SeaportOfferItem & {
    recipient: Hex;
};

type SeaportOrderComponents = {
    offerer: Hex;
    zone: Hex;
    offer: SeaportOfferItem[];
    consideration: SeaportConsiderationItem[];
    orderType: number;
    startTime: bigint;
    endTime: bigint;
    zoneHash: Hex;
    salt: bigint;
    conduitKey: Hex;
    counter: bigint;
};

export function resolveSeaportProtocolVersion(protocolAddress: string): string {
    const version = SEAPORT_V1_6_PROTOCOL_ADDRESSES.get(
        getAddress(protocolAddress),
    );
    if (!version) {
        throw new Error(
            `Unsupported Seaport protocol address: ${protocolAddress}`,
        );
    }
    return version;
}

export function buildSeaportOrderComponents(
    seaportData: SeaportOrderData,
): SeaportOrderComponents {
    return {
        offerer: getAddress(seaportData.offerer),
        zone: getAddress(seaportData.zone),
        offer: seaportData.offer.map((item) => ({
            itemType: Number(item.itemType),
            token: getAddress(item.token),
            identifierOrCriteria: BigInt(item.identifierOrCriteria),
            startAmount: BigInt(item.startAmount),
            endAmount: BigInt(item.endAmount),
        })),
        consideration: seaportData.consideration.map((item) => ({
            itemType: Number(item.itemType),
            token: getAddress(item.token),
            identifierOrCriteria: BigInt(item.identifierOrCriteria),
            startAmount: BigInt(item.startAmount),
            endAmount: BigInt(item.endAmount),
            recipient: getAddress(item.recipient),
        })),
        orderType: Number(seaportData.orderType),
        startTime: BigInt(seaportData.startTime),
        endTime: BigInt(seaportData.endTime),
        zoneHash: seaportData.zoneHash as Hex,
        salt: BigInt(seaportData.salt),
        conduitKey: seaportData.conduitKey as Hex,
        counter: BigInt(seaportData.counter),
    };
}

export function computeSeaportOrderHash(seaportData: SeaportOrderData): Hex {
    return deriveSeaportOrderHash(buildSeaportOrderComponents(seaportData));
}

export async function recoverSeaportSigner(
    chainId: number,
    seaportData: SeaportOrderData,
): Promise<string> {
    if (!seaportData.signature) {
        throw new Error("Missing Seaport signature");
    }

    const orderComponents = buildSeaportOrderComponents(seaportData);
    const recovered = await recoverTypedDataAddress({
        domain: buildSeaportTypedDataDomain(
            chainId,
            seaportData.protocolAddress,
        ),
        types: EIP_712_ORDER_TYPE,
        primaryType: "OrderComponents",
        message: orderComponents,
        signature: seaportData.signature as Hex,
    });

    return getAddress(recovered);
}

function buildSeaportTypedDataDomain(chainId: number, protocolAddress: string) {
    return {
        name: SEAPORT_CONTRACT_NAME,
        version: resolveSeaportProtocolVersion(protocolAddress),
        chainId,
        verifyingContract: getAddress(protocolAddress),
    } as const;
}

// Provider-free local hash routine aligned with Seaport's EIP-712 order hash.
function deriveSeaportOrderHash(orderComponents: SeaportOrderComponents): Hex {
    const offerItemTypeString =
        "OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)";
    const considerationItemTypeString =
        "ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)";
    const orderComponentsTypeString =
        "OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)";
    const orderTypeString = `${orderComponentsTypeString}${considerationItemTypeString}${offerItemTypeString}`;

    const offerItemTypeHash = keccak256(stringToBytes(offerItemTypeString));
    const considerationItemTypeHash = keccak256(
        stringToBytes(considerationItemTypeString),
    );
    const orderTypeHash = keccak256(stringToBytes(orderTypeString));

    const offerHash = keccak256Concat(
        orderComponents.offer.map((offerItem) =>
            keccak256(
                concatHex([
                    offerItemTypeHash,
                    uintToWordHex(offerItem.itemType),
                    hexToWord(offerItem.token),
                    uintToWordHex(offerItem.identifierOrCriteria),
                    uintToWordHex(offerItem.startAmount),
                    uintToWordHex(offerItem.endAmount),
                ]),
            ),
        ),
    );

    const considerationHash = keccak256Concat(
        orderComponents.consideration.map((considerationItem) =>
            keccak256(
                concatHex([
                    considerationItemTypeHash,
                    uintToWordHex(considerationItem.itemType),
                    hexToWord(considerationItem.token),
                    uintToWordHex(considerationItem.identifierOrCriteria),
                    uintToWordHex(considerationItem.startAmount),
                    uintToWordHex(considerationItem.endAmount),
                    hexToWord(considerationItem.recipient),
                ]),
            ),
        ),
    );

    return keccak256(
        concatHex([
            orderTypeHash,
            hexToWord(orderComponents.offerer),
            hexToWord(orderComponents.zone),
            offerHash,
            considerationHash,
            uintToWordHex(orderComponents.orderType),
            uintToWordHex(orderComponents.startTime),
            uintToWordHex(orderComponents.endTime),
            hexToWord(orderComponents.zoneHash),
            uintToWordHex(orderComponents.salt),
            hexToWord(orderComponents.conduitKey),
            uintToWordHex(orderComponents.counter),
        ]),
    );
}

function keccak256Concat(values: Hex[]): Hex {
    if (values.length === 0) {
        return keccak256("0x");
    }
    return keccak256(concatHex(values));
}

function hexToWord(value: Hex): Hex {
    return toHex(BigInt(value), { size: 32 });
}

function uintToWordHex(value: bigint | number): Hex {
    return toHex(value, { size: 32 });
}
