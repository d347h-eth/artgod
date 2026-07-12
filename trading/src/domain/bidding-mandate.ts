import { BIDDER_TARGET_TYPE, type BidderJob } from "./market/strategy/job.js";
import {
    EVM_PENDING_NONCE_POLICY,
    type EvmPendingNoncePolicy,
} from "@artgod/shared/evm/transactions";
import { maxUint256 } from "viem";

const EVM_ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;

type BiddingCollectionAuthority = {
    collectionId: number;
    contractAddress: string;
    openseaSlug: string;
    maxUnitBidWei: bigint;
    maxQuantity: bigint;
};

export type BiddingWethApprovalPolicySnapshot = {
    minPriorityFeePerGasWei: string;
    maxFeePerGasWei: string;
    maxTotalGasFeeWei: string;
    pendingNoncePolicy: EvmPendingNoncePolicy;
};

export type BiddingStartPolicySnapshot = {
    wethAllowanceCapWei: string;
    trustOpenSeaSignedZoneTraitOffers: boolean;
    wethApproval: BiddingWethApprovalPolicySnapshot;
};

// Carries the non-secret authority accepted by one bidding process into local runtime projections.
export type BiddingMandateSnapshot = {
    chainId: number;
    startPolicy: BiddingStartPolicySnapshot;
    collections: Array<{
        collectionId: number;
        contractAddress: string;
        openseaSlug: string;
        maxUnitBidWei: string;
        maxQuantity: number;
    }>;
};

// Owns the canonical allowance, trait-trust, and approval transaction authority for one process.
export class BiddingStartPolicy {
    public readonly wethAllowanceCapWei: bigint;
    public readonly trustOpenSeaSignedZoneTraitOffers: boolean;
    public readonly wethApproval: Readonly<{
        minPriorityFeePerGasWei: bigint;
        maxFeePerGasWei: bigint;
        maxTotalGasFeeWei: bigint;
        pendingNoncePolicy: EvmPendingNoncePolicy;
    }>;

    private constructor(
        wethAllowanceCapWei: bigint,
        trustOpenSeaSignedZoneTraitOffers: boolean,
        wethApproval: {
            minPriorityFeePerGasWei: bigint;
            maxFeePerGasWei: bigint;
            maxTotalGasFeeWei: bigint;
            pendingNoncePolicy: EvmPendingNoncePolicy;
        },
    ) {
        this.wethAllowanceCapWei = wethAllowanceCapWei;
        this.trustOpenSeaSignedZoneTraitOffers =
            trustOpenSeaSignedZoneTraitOffers;
        this.wethApproval = Object.freeze(wethApproval);
        Object.freeze(this);
    }

    // Parses the complete global authority before any runtime adapter is composed.
    public static parse(raw: unknown): BiddingStartPolicy {
        if (!isRecord(raw)) {
            throw new BiddingMandateViolationError(
                "start policy must be an object",
            );
        }
        if (typeof raw.trustOpenSeaSignedZoneTraitOffers !== "boolean") {
            throw new BiddingMandateViolationError(
                "start policy trait trust must be a boolean",
            );
        }
        if (!isRecord(raw.wethApproval)) {
            throw new BiddingMandateViolationError(
                "WETH approval policy must be an object",
            );
        }

        const wethAllowanceCapWei = requireCanonicalUint(
            raw.wethAllowanceCapWei,
            "WETH allowance cap",
            true,
        );
        const minPriorityFeePerGasWei = requireCanonicalUint(
            raw.wethApproval.minPriorityFeePerGasWei,
            "WETH approval minimum priority fee per gas",
            false,
        );
        const maxFeePerGasWei = requireCanonicalUint(
            raw.wethApproval.maxFeePerGasWei,
            "WETH approval maximum fee per gas",
            false,
        );
        const maxTotalGasFeeWei = requireCanonicalUint(
            raw.wethApproval.maxTotalGasFeeWei,
            "WETH approval maximum total gas fee",
            false,
        );
        if (minPriorityFeePerGasWei > maxFeePerGasWei) {
            throw new BiddingMandateViolationError(
                "WETH approval minimum priority fee per gas exceeds maximum fee per gas",
            );
        }
        if (
            raw.wethApproval.pendingNoncePolicy !==
            EVM_PENDING_NONCE_POLICY.Fail
        ) {
            throw new BiddingMandateViolationError(
                "WETH approval pending nonce policy is unsupported",
            );
        }

        return new BiddingStartPolicy(
            wethAllowanceCapWei,
            raw.trustOpenSeaSignedZoneTraitOffers,
            {
                minPriorityFeePerGasWei,
                maxFeePerGasWei,
                maxTotalGasFeeWei,
                pendingNoncePolicy: EVM_PENDING_NONCE_POLICY.Fail,
            },
        );
    }

    // Returns the exact canonical base-unit authority for projections and logs.
    public snapshot(): BiddingStartPolicySnapshot {
        return {
            wethAllowanceCapWei: this.wethAllowanceCapWei.toString(),
            trustOpenSeaSignedZoneTraitOffers:
                this.trustOpenSeaSignedZoneTraitOffers,
            wethApproval: {
                minPriorityFeePerGasWei:
                    this.wethApproval.minPriorityFeePerGasWei.toString(),
                maxFeePerGasWei:
                    this.wethApproval.maxFeePerGasWei.toString(),
                maxTotalGasFeeWei:
                    this.wethApproval.maxTotalGasFeeWei.toString(),
                pendingNoncePolicy: this.wethApproval.pendingNoncePolicy,
            },
        };
    }
}

// Signals that an offer falls outside the authority granted by the native prompt.
export class BiddingMandateViolationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BiddingMandateViolationError";
    }
}

// Enforces the immutable native mandate independently of loopback HTTP and persisted job state.
export class BiddingMandate {
    public readonly chainId: number;
    public readonly startPolicy: BiddingStartPolicy;
    private readonly collectionsById: ReadonlyMap<
        number,
        BiddingCollectionAuthority
    >;

    private constructor(
        chainId: number,
        startPolicy: BiddingStartPolicy,
        collections: BiddingCollectionAuthority[],
    ) {
        this.chainId = chainId;
        this.startPolicy = startPolicy;
        this.collectionsById = new Map(
            collections.map((collection) => [
                collection.collectionId,
                Object.freeze(collection),
            ]),
        );
        Object.freeze(this);
    }

    // Parses and normalizes the complete native authority before runtime composition begins.
    public static parse(raw: unknown, expectedChainId: number): BiddingMandate {
        if (!isRecord(raw)) {
            throw new BiddingMandateViolationError("mandate must be an object");
        }
        const chainId = requirePositiveSafeInteger(raw.chainId, "chain id");
        if (chainId !== expectedChainId) {
            throw new BiddingMandateViolationError(
                `chain id ${chainId} does not match envelope chain ${expectedChainId}`,
            );
        }
        const startPolicy = BiddingStartPolicy.parse(raw.startPolicy);
        if (!Array.isArray(raw.collections) || raw.collections.length === 0) {
            throw new BiddingMandateViolationError(
                "mandate must authorize at least one collection",
            );
        }

        const seenCollectionIds = new Set<number>();
        const collections = raw.collections.map((value, index) => {
            const collection = parseCollection(value, index);
            if (seenCollectionIds.has(collection.collectionId)) {
                throw new BiddingMandateViolationError(
                    `collection ${collection.collectionId} is duplicated`,
                );
            }
            seenCollectionIds.add(collection.collectionId);
            return collection;
        });
        return new BiddingMandate(chainId, startPolicy, collections);
    }

    // Rejects a proposed final offer when its identity, quantity, or unit price exceeds the mandate.
    public assertOfferAuthorized(job: BidderJob, totalAmountWei: bigint): void {
        const authority = this.collectionsById.get(job.collectionId);
        if (!authority) {
            throw new BiddingMandateViolationError(
                `collection ${job.collectionId} is not authorized`,
            );
        }
        if (
            normalizeAddress(job.collectionAddress) !==
            authority.contractAddress
        ) {
            throw new BiddingMandateViolationError(
                `collection ${job.collectionId} contract does not match`,
            );
        }
        if (normalizeSlug(job.collectionSlug) !== authority.openseaSlug) {
            throw new BiddingMandateViolationError(
                `collection ${job.collectionId} OpenSea slug does not match`,
            );
        }

        const quantity = resolveOfferQuantity(job);
        if (quantity > authority.maxQuantity) {
            throw new BiddingMandateViolationError(
                `collection ${job.collectionId} quantity ${quantity} exceeds cap ${authority.maxQuantity}`,
            );
        }
        if (totalAmountWei <= 0n) {
            throw new BiddingMandateViolationError(
                "offer amount must be positive",
            );
        }
        const totalCapWei = authority.maxUnitBidWei * quantity;
        if (totalAmountWei > totalCapWei) {
            throw new BiddingMandateViolationError(
                `collection ${job.collectionId} total ${totalAmountWei} exceeds unit cap ${authority.maxUnitBidWei} for quantity ${quantity}`,
            );
        }
    }

    // Returns a display-safe copy of the exact authority enforced by this process.
    public snapshot(): BiddingMandateSnapshot {
        return {
            chainId: this.chainId,
            startPolicy: this.startPolicy.snapshot(),
            collections: Array.from(
                this.collectionsById.values(),
                (collection) => ({
                    collectionId: collection.collectionId,
                    contractAddress: collection.contractAddress,
                    openseaSlug: collection.openseaSlug,
                    maxUnitBidWei: collection.maxUnitBidWei.toString(),
                    maxQuantity: Number(collection.maxQuantity),
                }),
            ),
        };
    }

    // Keeps diagnostics serializable without exposing mutable BigInt-backed internals.
    public toJSON(): BiddingMandateSnapshot {
        return this.snapshot();
    }
}

function parseCollection(
    raw: unknown,
    index: number,
): BiddingCollectionAuthority {
    if (!isRecord(raw)) {
        throw new BiddingMandateViolationError(
            `collection at index ${index} must be an object`,
        );
    }
    const collectionId = requirePositiveSafeInteger(
        raw.collectionId,
        `collection at index ${index} id`,
    );
    requireNonEmptyString(
        raw.artgodSlug,
        `collection ${collectionId} ArtGod slug`,
    );
    const contractAddress = normalizeAddress(
        requireNonEmptyString(
            raw.contractAddress,
            `collection ${collectionId} contract`,
        ),
    );
    const openseaSlug = normalizeSlug(
        requireNonEmptyString(
            raw.openseaSlug,
            `collection ${collectionId} OpenSea slug`,
        ),
    );
    const maxUnitBidWei = requirePositiveBigInt(
        raw.maxUnitBidWei,
        `collection ${collectionId} unit bid cap`,
    );
    const maxQuantity = BigInt(
        requirePositiveSafeInteger(
            raw.maxQuantity,
            `collection ${collectionId} quantity cap`,
        ),
    );
    return {
        collectionId,
        contractAddress,
        openseaSlug,
        maxUnitBidWei,
        maxQuantity,
    };
}

function resolveOfferQuantity(job: BidderJob): bigint {
    if (job.target.type === BIDDER_TARGET_TYPE.Token) {
        return 1n;
    }
    if (
        !Number.isSafeInteger(job.target.quantity) ||
        job.target.quantity <= 0
    ) {
        throw new BiddingMandateViolationError(
            `collection ${job.collectionId} offer quantity is invalid`,
        );
    }
    return BigInt(job.target.quantity);
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new BiddingMandateViolationError(
            `${label} must be a positive safe integer`,
        );
    }
    return value as number;
}

function requirePositiveBigInt(value: unknown, label: string): bigint {
    return requireCanonicalUint(value, label, false);
}

function requireCanonicalUint(
    value: unknown,
    label: string,
    allowZero: boolean,
): bigint {
    const pattern = allowZero
        ? NON_NEGATIVE_INTEGER_PATTERN
        : POSITIVE_INTEGER_PATTERN;
    if (typeof value !== "string" || !pattern.test(value)) {
        throw new BiddingMandateViolationError(
            `${label} must be canonical ${allowZero ? "non-negative" : "positive"} wei`,
        );
    }
    const parsed = BigInt(value);
    if (parsed > maxUint256) {
        throw new BiddingMandateViolationError(
            `${label} exceeds uint256`,
        );
    }
    return parsed;
}

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new BiddingMandateViolationError(`${label} must be non-empty`);
    }
    return value.trim();
}

function normalizeAddress(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!EVM_ADDRESS_PATTERN.test(normalized)) {
        throw new BiddingMandateViolationError(
            "collection contract must be an EVM address",
        );
    }
    return normalized;
}

function normalizeSlug(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === "") {
        throw new BiddingMandateViolationError(
            "OpenSea slug must be non-empty",
        );
    }
    return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
