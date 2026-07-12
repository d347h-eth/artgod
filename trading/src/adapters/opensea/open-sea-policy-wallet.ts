import { AsyncLocalStorage } from "node:async_hooks";
import {
    getAddress,
    maxUint256,
    type Address,
    type Hex,
    type WalletClient,
} from "viem";
import { mainnet } from "viem/chains";
import { OPENSEA_MAINNET_SECURITY_POLICY } from "@artgod/shared/trading/open-sea-mainnet-security-policy";
import {
    BiddingMandate,
    BiddingMandateViolationError,
} from "../../domain/bidding-mandate.js";
import {
    BIDDER_TARGET_TYPE,
    bidderTargetRequiresOpenSeaSignedZoneTrust,
    type BidderJob,
} from "../../domain/market/strategy/job.js";

const OPEN_SEA_SIGNING_INTENT = {
    Offer: "offer",
    OffchainCancellation: "offchain_cancellation",
} as const;

const OPEN_SEA_SDK_WALLET_ACTION = {
    SendTransaction: "sendTransaction",
    WriteContract: "writeContract",
    SignMessage: "signMessage",
    SignTransaction: "signTransaction",
} as const;

const OPEN_SEA_SIGNATURE_STATE = {
    Available: "available",
    Pending: "pending",
    Complete: "complete",
} as const;

const SEAPORT_PRIMARY_TYPE = {
    OrderComponents: "OrderComponents",
    OrderHash: "OrderHash",
} as const;

const SEAPORT_ITEM_TYPE = {
    Erc20: 1n,
    Erc721: 2n,
    Erc1155: 3n,
    Erc721WithCriteria: 4n,
    Erc1155WithCriteria: 5n,
} as const;

const SEAPORT_ORDER_TYPE = {
    PartialRestricted: 3n,
} as const;

const SEAPORT_ORDER_TYPES = {
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

const SEAPORT_ORDER_HASH_TYPES = {
    OrderHash: [{ name: "orderHash", type: "bytes32" }],
} as const;

// EIP-712 domain fields accepted by the pinned Seaport signing policy.
const SEAPORT_DOMAIN_FIELDS = [
    "chainId",
    "name",
    "version",
    "verifyingContract",
] as const;

type OpenSeaTypedDataInput = {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
};

export type OpenSeaPolicyTypedDataSigner = {
    address: string;
    signTypedData(input: OpenSeaTypedDataInput): Promise<Hex>;
};

export type OpenSeaOfferSigningAuthorization = {
    job: BidderJob;
    totalAmountWei: bigint;
    expirationTime: number;
};

export type OpenSeaPolicyWalletOptions = {
    makerAddress: string;
    wethAddress: string;
    allowanceCapWei: bigint;
    trustOpenSeaSignedZoneTraitOffers: boolean;
    biddingMandate: BiddingMandate;
};

type OfferSigningSession = {
    intent: typeof OPEN_SEA_SIGNING_INTENT.Offer;
    active: boolean;
    expectation: OfferSigningExpectation;
    signatureState: (typeof OPEN_SEA_SIGNATURE_STATE)[keyof typeof OPEN_SEA_SIGNATURE_STATE];
};

type OfferSigningExpectation = {
    collectionAddress: Address;
    tokenId: bigint | null;
    quantity: bigint;
    requiresSignedZoneTrust: boolean;
    totalAmountWei: bigint;
    expirationTime: number;
};

type CancellationSigningSession = {
    intent: typeof OPEN_SEA_SIGNING_INTENT.OffchainCancellation;
    active: boolean;
    protocolAddress: Address;
    orderHash: Hex;
    signatureState: (typeof OPEN_SEA_SIGNATURE_STATE)[keyof typeof OPEN_SEA_SIGNATURE_STATE];
};

type SigningSession = OfferSigningSession | CancellationSigningSession;

// Raised whenever the SDK asks ArtGod to sign or transact outside the active bidding policy.
export class OpenSeaPolicyViolationError extends Error {
    constructor(message: string) {
        super(`OpenSea wallet policy rejected request: ${message}`);
        this.name = "OpenSeaPolicyViolationError";
    }
}

// Restricts the OpenSea SDK to one validated typed-data signature for each authorized operation.
export class OpenSeaPolicyWallet {
    public readonly walletClient: WalletClient;

    private readonly makerAddress: Address;
    private readonly wethAddress: Address;
    private readonly signingSessions = new AsyncLocalStorage<SigningSession>();

    constructor(
        private readonly signer: OpenSeaPolicyTypedDataSigner,
        private readonly options: OpenSeaPolicyWalletOptions,
    ) {
        this.makerAddress = normalizeAddress(
            options.makerAddress,
            "configured maker address",
        );
        this.wethAddress = normalizeAddress(
            options.wethAddress,
            "configured WETH address",
        );
        assertAddressEquals(
            this.signer.address,
            this.makerAddress,
            "typed-data signer",
        );
        assertAddressEquals(
            this.wethAddress,
            OPENSEA_MAINNET_SECURITY_POLICY.wethAddress,
            "configured WETH address",
        );
        if (options.allowanceCapWei < 0n) {
            throw new OpenSeaPolicyViolationError(
                "configured WETH allowance cap must be non-negative",
            );
        }

        const restrictedAccount = Object.freeze({
            address: this.makerAddress,
            type: "local",
        });
        this.walletClient = Object.freeze({
            account: restrictedAccount,
            chain: mainnet,
            signTypedData: async (input: unknown) =>
                await this.signTypedData(input),
            sendTransaction: async () =>
                this.rejectWalletAction(
                    OPEN_SEA_SDK_WALLET_ACTION.SendTransaction,
                ),
            writeContract: async () =>
                this.rejectWalletAction(
                    OPEN_SEA_SDK_WALLET_ACTION.WriteContract,
                ),
            signMessage: async () =>
                this.rejectWalletAction(OPEN_SEA_SDK_WALLET_ACTION.SignMessage),
            signTransaction: async () =>
                this.rejectWalletAction(
                    OPEN_SEA_SDK_WALLET_ACTION.SignTransaction,
                ),
        }) as unknown as WalletClient;
    }

    // Authorizes exactly one offer signature while the SDK performs its existing build and post flow.
    public async authorizeOffer<T>(
        authorization: OpenSeaOfferSigningAuthorization,
        work: () => Promise<T>,
    ): Promise<T> {
        const expectation = this.createOfferSigningExpectation(authorization);
        return await this.runSigningSession(
            {
                intent: OPEN_SEA_SIGNING_INTENT.Offer,
                active: true,
                expectation,
                signatureState: OPEN_SEA_SIGNATURE_STATE.Available,
            },
            work,
        );
    }

    // Authorizes exactly one pinned Seaport OrderHash signature for an offchain cancellation.
    public async authorizeOffchainCancellation<T>(
        protocolAddress: string,
        orderHash: string,
        work: () => Promise<T>,
    ): Promise<T> {
        const normalizedProtocolAddress = normalizeAddress(
            protocolAddress,
            "cancellation protocol address",
        );
        assertAddressEquals(
            normalizedProtocolAddress,
            OPENSEA_MAINNET_SECURITY_POLICY.seaportAddress,
            "cancellation protocol address",
        );
        const normalizedOrderHash = requireBytes32(
            orderHash,
            "cancellation order hash",
        );
        return await this.runSigningSession(
            {
                intent: OPEN_SEA_SIGNING_INTENT.OffchainCancellation,
                active: true,
                protocolAddress: normalizedProtocolAddress,
                orderHash: normalizedOrderHash,
                signatureState: OPEN_SEA_SIGNATURE_STATE.Available,
            },
            work,
        );
    }

    private async runSigningSession<T>(
        session: SigningSession,
        work: () => Promise<T>,
    ): Promise<T> {
        return await this.signingSessions.run(session, async () => {
            try {
                const result = await work();
                if (
                    session.signatureState !== OPEN_SEA_SIGNATURE_STATE.Complete
                ) {
                    throw new OpenSeaPolicyViolationError(
                        `authorized ${session.intent} completed with 0 signatures`,
                    );
                }
                return result;
            } finally {
                session.active = false;
            }
        });
    }

    private createOfferSigningExpectation(
        authorization: OpenSeaOfferSigningAuthorization,
    ): OfferSigningExpectation {
        try {
            // Enforce native collection identity and caps at the final signing boundary.
            this.options.biddingMandate.assertOfferAuthorized(
                authorization.job,
                authorization.totalAmountWei,
            );
        } catch (error) {
            if (error instanceof BiddingMandateViolationError) {
                throw new OpenSeaPolicyViolationError(
                    `native bidding mandate rejected offer: ${error.message}`,
                );
            }
            throw error;
        }
        if (authorization.totalAmountWei <= 0n) {
            throw new OpenSeaPolicyViolationError(
                "offer amount must be positive",
            );
        }
        if (authorization.totalAmountWei > this.options.allowanceCapWei) {
            throw new OpenSeaPolicyViolationError(
                `offer amount ${authorization.totalAmountWei} exceeds configured WETH allowance cap ${this.options.allowanceCapWei}`,
            );
        }
        if (
            !Number.isSafeInteger(authorization.expirationTime) ||
            authorization.expirationTime <= 0
        ) {
            throw new OpenSeaPolicyViolationError(
                "offer expiration must be a positive safe integer",
            );
        }
        const collectionAddress = normalizeAddress(
            authorization.job.collectionAddress,
            "offer collection address",
        );
        const requiresSignedZoneTrust =
            bidderTargetRequiresOpenSeaSignedZoneTrust(
                authorization.job.target,
            );
        if (
            requiresSignedZoneTrust &&
            !this.options.trustOpenSeaSignedZoneTraitOffers
        ) {
            throw new OpenSeaPolicyViolationError(
                "trait offer requires explicit OpenSea SignedZone trust",
            );
        }

        const target = authorization.job.target;
        return {
            collectionAddress,
            tokenId:
                target.type === BIDDER_TARGET_TYPE.Token
                    ? requireUint(target.tokenId, "authorized token id")
                    : null,
            quantity:
                target.type === BIDDER_TARGET_TYPE.Token
                    ? 1n
                    : normalizeTargetQuantity(target.quantity),
            requiresSignedZoneTrust,
            totalAmountWei: authorization.totalAmountWei,
            expirationTime: authorization.expirationTime,
        };
    }

    private async signTypedData(input: unknown): Promise<Hex> {
        const session = this.signingSessions.getStore();
        if (!session) {
            throw new OpenSeaPolicyViolationError(
                "typed-data signature was requested without authorization",
            );
        }
        if (!session.active) {
            throw new OpenSeaPolicyViolationError(
                `authorized ${session.intent} is no longer active`,
            );
        }
        if (session.signatureState !== OPEN_SEA_SIGNATURE_STATE.Available) {
            throw new OpenSeaPolicyViolationError(
                `authorized ${session.intent} requested more than one signature`,
            );
        }

        const typedData = normalizeTypedDataInput(input);
        if (session.intent === OPEN_SEA_SIGNING_INTENT.Offer) {
            this.assertOfferTypedData(typedData, session.expectation);
        } else {
            this.assertCancellationTypedData(typedData, session);
        }

        session.signatureState = OPEN_SEA_SIGNATURE_STATE.Pending;
        try {
            // Forward only the validated EIP-712 payload, never the SDK-provided account object.
            const signature = await this.signer.signTypedData(typedData);
            if (!session.active) {
                throw new OpenSeaPolicyViolationError(
                    `authorized ${session.intent} is no longer active`,
                );
            }
            session.signatureState = OPEN_SEA_SIGNATURE_STATE.Complete;
            return signature;
        } catch (error) {
            session.signatureState = OPEN_SEA_SIGNATURE_STATE.Available;
            throw error;
        }
    }

    private assertOfferTypedData(
        typedData: OpenSeaTypedDataInput,
        expectation: OfferSigningExpectation,
    ): void {
        assertSeaportDomain(
            typedData.domain,
            OPENSEA_MAINNET_SECURITY_POLICY.seaportAddress,
        );
        assertPrimaryType(
            typedData.primaryType,
            SEAPORT_PRIMARY_TYPE.OrderComponents,
        );
        assertTypedDataTypes(typedData.types, SEAPORT_ORDER_TYPES);

        const order = typedData.message;
        assertAddressEquals(
            requireString(order.offerer, "order offerer"),
            this.makerAddress,
            "order offerer",
        );
        assertAddressEquals(
            requireString(order.zone, "order zone"),
            OPENSEA_MAINNET_SECURITY_POLICY.signedZoneAddress,
            "order zone",
        );
        assertBytes32Equals(
            order.zoneHash,
            OPENSEA_MAINNET_SECURITY_POLICY.zeroBytes32,
            "order zone hash",
        );
        assertBytes32Equals(
            order.conduitKey,
            OPENSEA_MAINNET_SECURITY_POLICY.conduitKey,
            "order conduit key",
        );
        assertUintEquals(
            order.orderType,
            SEAPORT_ORDER_TYPE.PartialRestricted,
            "order type",
        );
        const startTime = requireUint(order.startTime, "order start time");
        const endTime = requireUint(order.endTime, "order end time");
        assertUintEquals(
            endTime,
            BigInt(expectation.expirationTime),
            "order expiration",
        );
        if (startTime > endTime) {
            throw new OpenSeaPolicyViolationError(
                "order start time exceeds expiration",
            );
        }
        requireUint(order.salt, "order salt");
        requireUint(order.counter, "order counter");

        this.assertOfferItems(order.offer, expectation.totalAmountWei);
        this.assertConsiderationItems(order.consideration, expectation);
        if (order.totalOriginalConsiderationItems !== undefined) {
            assertUintEquals(
                order.totalOriginalConsiderationItems,
                BigInt(
                    requireArray(order.consideration, "order consideration")
                        .length,
                ),
                "total original consideration item count",
            );
        }
    }

    private assertOfferItems(value: unknown, totalAmountWei: bigint): void {
        const items = requireArray(value, "order offer");
        if (items.length !== 1) {
            throw new OpenSeaPolicyViolationError(
                `order must contain exactly one WETH offer item; received ${items.length}`,
            );
        }
        const item = requireRecord(items[0], "WETH offer item");
        assertUintEquals(
            item.itemType,
            SEAPORT_ITEM_TYPE.Erc20,
            "WETH offer item type",
        );
        assertAddressEquals(
            requireString(item.token, "WETH offer token"),
            this.wethAddress,
            "WETH offer token",
        );
        assertUintEquals(
            item.identifierOrCriteria,
            0n,
            "WETH offer identifier",
        );
        assertUintEquals(
            item.startAmount,
            totalAmountWei,
            "WETH offer start amount",
        );
        assertUintEquals(
            item.endAmount,
            totalAmountWei,
            "WETH offer end amount",
        );
    }

    private assertConsiderationItems(
        value: unknown,
        expectation: OfferSigningExpectation,
    ): void {
        const items = requireArray(value, "order consideration").map(
            (item, index) =>
                requireRecord(item, `order consideration item ${index}`),
        );
        const nftItems = items.filter(
            (item) =>
                normalizeAddress(
                    requireString(item.token, "consideration token"),
                    "consideration token",
                ) === expectation.collectionAddress,
        );
        if (nftItems.length !== 1) {
            throw new OpenSeaPolicyViolationError(
                `order must contain exactly one target NFT item; received ${nftItems.length}`,
            );
        }

        this.assertTargetNftItem(nftItems[0], expectation);
        let feeTotalWei = 0n;
        for (const item of items) {
            if (item === nftItems[0]) {
                continue;
            }
            feeTotalWei += this.assertWethFeeItem(item);
        }
        if (feeTotalWei > expectation.totalAmountWei) {
            throw new OpenSeaPolicyViolationError(
                `order fee allocations ${feeTotalWei} exceed offer amount ${expectation.totalAmountWei}`,
            );
        }
    }

    private assertTargetNftItem(
        item: Record<string, unknown>,
        expectation: OfferSigningExpectation,
    ): void {
        assertAddressEquals(
            requireString(item.recipient, "target NFT recipient"),
            this.makerAddress,
            "target NFT recipient",
        );
        if (expectation.tokenId !== null) {
            assertOneOfUint(
                item.itemType,
                [SEAPORT_ITEM_TYPE.Erc721, SEAPORT_ITEM_TYPE.Erc1155],
                "target NFT item type",
            );
            assertUintEquals(
                item.identifierOrCriteria,
                expectation.tokenId,
                "target token id",
            );
            assertConstantItemAmount(item, 1n, "target token amount");
            return;
        }

        assertOneOfUint(
            item.itemType,
            [
                SEAPORT_ITEM_TYPE.Erc721WithCriteria,
                SEAPORT_ITEM_TYPE.Erc1155WithCriteria,
            ],
            "target NFT criteria item type",
        );
        if (!expectation.requiresSignedZoneTrust) {
            assertUintEquals(
                item.identifierOrCriteria,
                0n,
                "collection-wide criteria root",
            );
        } else {
            requireUint(item.identifierOrCriteria, "trait criteria root");
        }
        assertConstantItemAmount(
            item,
            expectation.quantity,
            "target NFT quantity",
        );
    }

    private assertWethFeeItem(item: Record<string, unknown>): bigint {
        assertUintEquals(
            item.itemType,
            SEAPORT_ITEM_TYPE.Erc20,
            "fee item type",
        );
        assertAddressEquals(
            requireString(item.token, "fee token"),
            this.wethAddress,
            "fee token",
        );
        assertUintEquals(item.identifierOrCriteria, 0n, "fee identifier");
        const recipient = normalizeAddress(
            requireString(item.recipient, "fee recipient"),
            "fee recipient",
        );
        if (
            recipient ===
            normalizeAddress(
                OPENSEA_MAINNET_SECURITY_POLICY.zeroAddress,
                "zero address",
            )
        ) {
            throw new OpenSeaPolicyViolationError(
                "fee recipient must not be the zero address",
            );
        }
        const amount = requireUint(item.startAmount, "fee start amount");
        assertUintEquals(item.endAmount, amount, "fee end amount");
        return amount;
    }

    private assertCancellationTypedData(
        typedData: OpenSeaTypedDataInput,
        session: CancellationSigningSession,
    ): void {
        assertSeaportDomain(typedData.domain, session.protocolAddress);
        assertPrimaryType(
            typedData.primaryType,
            SEAPORT_PRIMARY_TYPE.OrderHash,
        );
        assertTypedDataTypes(typedData.types, SEAPORT_ORDER_HASH_TYPES);
        assertBytes32Equals(
            typedData.message.orderHash,
            session.orderHash,
            "cancellation order hash",
        );
    }

    private rejectWalletAction(action: string): never {
        throw new OpenSeaPolicyViolationError(
            `SDK wallet action ${action} is not permitted`,
        );
    }
}

function normalizeTypedDataInput(input: unknown): OpenSeaTypedDataInput {
    const record = requireRecord(input, "typed-data request");
    return Object.freeze({
        domain: snapshotRecord(record.domain, "typed-data domain"),
        types: snapshotRecord(record.types, "typed-data types"),
        primaryType: requireString(
            record.primaryType,
            "typed-data primary type",
        ),
        message: snapshotRecord(record.message, "typed-data message"),
    });
}

function snapshotRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    try {
        const snapshot = structuredClone(value);
        return deepFreeze(requireRecord(snapshot, label));
    } catch (error) {
        if (error instanceof OpenSeaPolicyViolationError) {
            throw error;
        }
        throw new OpenSeaPolicyViolationError(
            `${label} could not be copied into trusted memory`,
        );
    }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
    if (!value || typeof value !== "object" || seen.has(value)) {
        return value;
    }
    seen.add(value);
    for (const nested of Object.values(value)) {
        deepFreeze(nested, seen);
    }
    return Object.freeze(value);
}

function assertSeaportDomain(
    domain: Record<string, unknown>,
    expectedVerifyingContract: string,
): void {
    assertExactRecordFields(domain, SEAPORT_DOMAIN_FIELDS, "EIP-712 domain");
    assertUintEquals(
        domain.chainId,
        BigInt(OPENSEA_MAINNET_SECURITY_POLICY.chainId),
        "EIP-712 chain id",
    );
    assertStringEquals(
        domain.name,
        OPENSEA_MAINNET_SECURITY_POLICY.seaportName,
        "EIP-712 domain name",
    );
    assertStringEquals(
        domain.version,
        OPENSEA_MAINNET_SECURITY_POLICY.seaportVersion,
        "EIP-712 domain version",
    );
    assertAddressEquals(
        requireString(domain.verifyingContract, "EIP-712 verifying contract"),
        expectedVerifyingContract,
        "EIP-712 verifying contract",
    );
}

function assertExactRecordFields(
    value: Record<string, unknown>,
    expectedFields: readonly string[],
    label: string,
): void {
    const actualFields = Object.keys(value).sort();
    const sortedExpectedFields = [...expectedFields].sort();
    if (JSON.stringify(actualFields) !== JSON.stringify(sortedExpectedFields)) {
        throw new OpenSeaPolicyViolationError(
            `${label} fields differ; received ${actualFields.join(",")}`,
        );
    }
}

function assertTypedDataTypes(
    actual: Record<string, unknown>,
    expected: Record<string, readonly { name: string; type: string }[]>,
): void {
    const actualNames = Object.keys(actual).sort();
    const expectedNames = Object.keys(expected).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
        throw new OpenSeaPolicyViolationError(
            `typed-data schemas differ; received ${actualNames.join(",")}`,
        );
    }
    for (const name of expectedNames) {
        const fields = requireArray(actual[name], `typed-data schema ${name}`);
        const normalizedFields = fields.map((field, index) => {
            const record = requireRecord(
                field,
                `typed-data schema ${name} field ${index}`,
            );
            return {
                name: requireString(record.name, "typed-data field name"),
                type: requireString(record.type, "typed-data field type"),
            };
        });
        if (
            JSON.stringify(normalizedFields) !== JSON.stringify(expected[name])
        ) {
            throw new OpenSeaPolicyViolationError(
                `typed-data schema ${name} does not match the pinned Seaport schema`,
            );
        }
    }
}

function assertPrimaryType(actual: string, expected: string): void {
    if (actual !== expected) {
        throw new OpenSeaPolicyViolationError(
            `typed-data primary type must be ${expected}; received ${actual}`,
        );
    }
}

function assertConstantItemAmount(
    item: Record<string, unknown>,
    expected: bigint,
    label: string,
): void {
    assertUintEquals(item.startAmount, expected, `${label} start`);
    assertUintEquals(item.endAmount, expected, `${label} end`);
}

function normalizeTargetQuantity(value: number): bigint {
    const quantity = Math.max(1, Math.floor(value));
    if (!Number.isSafeInteger(quantity)) {
        throw new OpenSeaPolicyViolationError(
            "authorized target quantity must resolve to a safe integer",
        );
    }
    return BigInt(quantity);
}

function assertOneOfUint(
    value: unknown,
    expected: readonly bigint[],
    label: string,
): void {
    const actual = requireUint(value, label);
    if (!expected.includes(actual)) {
        throw new OpenSeaPolicyViolationError(
            `${label} must be one of ${expected.join(",")}; received ${actual}`,
        );
    }
}

function assertUintEquals(
    value: unknown,
    expected: bigint,
    label: string,
): void {
    const actual = requireUint(value, label);
    if (actual !== expected) {
        throw new OpenSeaPolicyViolationError(
            `${label} must be ${expected}; received ${actual}`,
        );
    }
}

function requireUint(value: unknown, label: string): bigint {
    let parsedValue: bigint | undefined;
    if (typeof value === "bigint") {
        parsedValue = value;
    }
    if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
    ) {
        parsedValue = BigInt(value);
    }
    if (
        typeof value === "string" &&
        (/^(0|[1-9]\d*)$/.test(value) || /^0x[0-9a-fA-F]+$/.test(value))
    ) {
        parsedValue = BigInt(value);
    }
    if (
        parsedValue !== undefined &&
        parsedValue >= 0n &&
        parsedValue <= maxUint256
    ) {
        return parsedValue;
    }
    throw new OpenSeaPolicyViolationError(
        `${label} must be an unsigned integer`,
    );
}

function assertStringEquals(
    value: unknown,
    expected: string,
    label: string,
): void {
    const actual = requireString(value, label);
    if (actual !== expected) {
        throw new OpenSeaPolicyViolationError(
            `${label} must be ${expected}; received ${actual}`,
        );
    }
}

function assertAddressEquals(
    value: string | Address,
    expected: string | Address,
    label: string,
): void {
    const actualAddress = normalizeAddress(value, label);
    const expectedAddress = normalizeAddress(expected, `expected ${label}`);
    if (actualAddress !== expectedAddress) {
        throw new OpenSeaPolicyViolationError(
            `${label} must be ${expectedAddress}; received ${actualAddress}`,
        );
    }
}

function normalizeAddress(value: string, label: string): Address {
    try {
        return getAddress(value);
    } catch {
        throw new OpenSeaPolicyViolationError(
            `${label} must be a valid EVM address`,
        );
    }
}

function assertBytes32Equals(
    value: unknown,
    expected: string,
    label: string,
): void {
    const actualHex = requireBytes32(value, label).toLowerCase();
    const expectedHex = requireBytes32(
        expected,
        `expected ${label}`,
    ).toLowerCase();
    if (actualHex !== expectedHex) {
        throw new OpenSeaPolicyViolationError(
            `${label} must be ${expectedHex}; received ${actualHex}`,
        );
    }
}

function requireBytes32(value: unknown, label: string): Hex {
    if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
        throw new OpenSeaPolicyViolationError(
            `${label} must be a 32-byte hex value`,
        );
    }
    return value as Hex;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new OpenSeaPolicyViolationError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new OpenSeaPolicyViolationError(`${label} must be an array`);
    }
    return value;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new OpenSeaPolicyViolationError(
            `${label} must be a non-empty string`,
        );
    }
    return value;
}
