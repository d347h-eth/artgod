import {
    compactSignatureToSignature,
    concatHex,
    getAddress,
    hashDomain,
    keccak256,
    recoverAddress,
    recoverTypedDataAddress,
    stringToBytes,
    toHex,
    type Hex,
    type Signature,
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

const EIP_712_DOMAIN_TYPE = {
    EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
    ],
} as const;

const SEAPORT_SIGNATURE = {
    compactBytes: 64,
    standardBytes: 65,
    bulkIndexBytes: 3,
    proofNodeBytes: 32,
    maxProofHeight: 24,
} as const;

// EIP-712 appends referenced struct definitions in alphabetical order.
const BULK_ORDER_DEPENDENCIES = (
    ["ConsiderationItem", "OfferItem", "OrderComponents"] as const
)
    .map(
        (name) =>
            `${name}(${EIP_712_ORDER_TYPE[name]
                .map((field) => `${field.type} ${field.name}`)
                .join(",")})`,
    )
    .join("");

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

    const signature = seaportData.signature;
    const signatureBytes = (signature.length - 2) / 2;
    const singleOrder =
        signatureBytes === SEAPORT_SIGNATURE.compactBytes ||
        signatureBytes === SEAPORT_SIGNATURE.standardBytes;
    // Bound work before parsing untrusted hex or hashing any proof nodes.
    const ecdsaBytes = SEAPORT_SIGNATURE.standardBytes - (signatureBytes % 2);
    const proofHeight =
        (signatureBytes - ecdsaBytes - SEAPORT_SIGNATURE.bulkIndexBytes) /
        SEAPORT_SIGNATURE.proofNodeBytes;
    if (
        !singleOrder &&
        (!Number.isInteger(proofHeight) ||
            proofHeight < 1 ||
            proofHeight > SEAPORT_SIGNATURE.maxProofHeight)
    ) {
        throw new Error("Unsupported Seaport signature length");
    }
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
        throw new Error("Invalid Seaport signature hex");
    }

    const orderComponents = buildSeaportOrderComponents(seaportData);
    const domain = buildSeaportTypedDataDomain(
        chainId,
        seaportData.protocolAddress,
    );
    if (!singleOrder) {
        const indexOffset = 2 + ecdsaBytes * 2;
        const proofOffset = indexOffset + SEAPORT_SIGNATURE.bulkIndexBytes * 2;
        const index = Number.parseInt(
            signature.slice(indexOffset, proofOffset),
            16,
        );
        let root = deriveSeaportOrderHash(orderComponents);
        for (let level = 0; level < proofHeight; level++) {
            const offset =
                proofOffset + level * SEAPORT_SIGNATURE.proofNodeBytes * 2;
            const sibling = `0x${signature.slice(
                offset,
                offset + SEAPORT_SIGNATURE.proofNodeBytes * 2,
            )}` as Hex;
            // Seaport uses positional siblings, not sorted pairs. Higher index
            // bits are ignored by the contract when they exceed the tree height.
            root = keccak256(
                concatHex(
                    (index >> level) & 1 ? [sibling, root] : [root, sibling],
                ),
            );
        }
        const bulkTypeHash = keccak256(
            stringToBytes(
                `BulkOrder(OrderComponents${"[2]".repeat(proofHeight)} tree)${BULK_ORDER_DEPENDENCIES}`,
            ),
        );
        const bulkOrderHash = keccak256(concatHex([bulkTypeHash, root]));
        const domainHash = hashDomain({
            domain,
            types: EIP_712_DOMAIN_TYPE,
        });
        // Only the reconstructed BulkOrder digest authorizes this leaf. Removing
        // the proof and recovering against OrderComponents would verify a
        // different message. See Seaport 1.6 Verifiers._computeBulkOrderProof.
        return getAddress(
            await recoverAddress({
                hash: keccak256(
                    concatHex(["0x1901", domainHash, bulkOrderHash]),
                ),
                signature: normalizeSeaportSignature(
                    signature.slice(0, indexOffset),
                ),
            }),
        );
    }

    const recovered = await recoverTypedDataAddress({
        domain,
        types: EIP_712_ORDER_TYPE,
        primaryType: "OrderComponents",
        message: orderComponents,
        signature: normalizeSeaportSignature(seaportData.signature),
    });

    return getAddress(recovered);
}

function normalizeSeaportSignature(signature: string): Hex | Signature {
    if (signature.length === 2 + SEAPORT_SIGNATURE.compactBytes * 2) {
        // OpenSea can emit EIP-2098 compact signatures; viem recovery expects an expanded signature shape.
        return compactSignatureToSignature({
            r: `0x${signature.slice(2, 66)}` as Hex,
            yParityAndS: `0x${signature.slice(66)}` as Hex,
        });
    }

    return signature as Hex;
}

function buildSeaportTypedDataDomain(chainId: number, protocolAddress: string) {
    return {
        name: SEAPORT_CONTRACT_NAME,
        version: resolveSeaportProtocolVersion(protocolAddress),
        chainId: BigInt(chainId),
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
