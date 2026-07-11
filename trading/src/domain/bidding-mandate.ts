import { BIDDER_TARGET_TYPE, type BidderJob } from "./market/strategy/job.js";

const EVM_ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

type BiddingCollectionAuthority = {
    collectionId: number;
    contractAddress: string;
    openseaSlug: string;
    maxUnitBidWei: bigint;
    maxQuantity: bigint;
};

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
    private readonly collectionsById: ReadonlyMap<
        number,
        BiddingCollectionAuthority
    >;

    private constructor(
        chainId: number,
        collections: BiddingCollectionAuthority[],
    ) {
        this.chainId = chainId;
        this.collectionsById = new Map(
            collections.map((collection) => [
                collection.collectionId,
                collection,
            ]),
        );
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
        return new BiddingMandate(chainId, collections);
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
    if (typeof value !== "string" || !POSITIVE_INTEGER_PATTERN.test(value)) {
        throw new BiddingMandateViolationError(
            `${label} must be canonical positive wei`,
        );
    }
    return BigInt(value);
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
