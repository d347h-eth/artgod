import {
    TRADING_BIDDING_BID_SCOPE_KIND,
    formatTradingBiddingBidScopeLabel,
    type TradingBiddingBidScopeKind,
    type TradingBiddingTraitCriterion,
} from "../types/trading.js";
import {
    dedupeBiddingTraitCriteria,
    parseBiddingTraitCriteria,
    numericTraitValue,
} from "./offer-trait-criteria.js";
import { OPENSEA_MAINNET_SECURITY_POLICY } from "./open-sea-mainnet-security-policy.js";
import {
    getOpenSeaOrderHash,
    getOpenSeaProtocolEnvelope,
    getOpenSeaProtocolParameters,
} from "../opensea/payload.js";
import { asRecord, asObject } from "../offchain/normalizer-utils.js";

export type OpenSeaBiddingOfferScope =
    | "item"
    | "collection"
    | "trait"
    | "unknown";

export type OpenSeaBiddingOfferDiscoverySource =
    | "itemOffers"
    | "collectionOffers"
    | "traitOffers"
    | "bestOffer"
    | "stateRecovery"
    | "unknown";

export type OpenSeaBiddingPriceExtraction = {
    price: bigint;
    source: string;
    quantity: bigint;
    currencyAddress: string;
};

export type OpenSeaBiddingOfferBidScope = {
    kind: TradingBiddingBidScopeKind;
    label: string;
    tokenId: string | null;
    traits: TradingBiddingTraitCriterion[];
    encodedTokenIds: string | null;
};

export type ParsedOpenSeaBiddingOffer = {
    id: string;
    price: bigint;
    maker: string;
    collectionAddress: string | null;
    currencyAddress: string | null;
    protocolAddress?: string;
    createdAt: string | null;
    validFrom?: number;
    expirationTime?: number;
    criteriaRoot: string | null;
    rawOrder: unknown;
    offerScope: OpenSeaBiddingOfferScope;
    discoverySource: OpenSeaBiddingOfferDiscoverySource;
    priceSource: string;
    source: string;
    quantity: bigint;
    bidScope: OpenSeaBiddingOfferBidScope;
};

export type ParseOpenSeaBiddingOfferOptions = {
    collectionAddress?: string;
    wethAddress?: string;
    discoverySource?: OpenSeaBiddingOfferDiscoverySource;
};

// OpenSea's finite membership is authoritative for token applicability, even
// when a trait-scoped offer also carries a descriptive criteria schema.
export function openSeaEncodedTokenIdsContain(
    encodedTokenIds: string,
    tokenId: string,
): boolean {
    if (!/^\d+$/.test(tokenId)) return false;
    if (encodedTokenIds === "*") return true;
    if (!encodedTokenIds) return false;
    const target = BigInt(tokenId);
    let contains = false;
    for (const segment of encodedTokenIds.split(",")) {
        if (!/^\d+(?::\d+)?$/.test(segment)) return false;
        const [startText, endText = startText] = segment.split(":");
        const start = BigInt(startText);
        const end = BigInt(endText);
        if (start > end) return false;
        if (target >= start && target <= end) contains = true;
    }
    return contains;
}

// Parses an OpenSea offer with the same price and scope semantics used by the bidder runtime.
export function parseOpenSeaBiddingOffer(
    rawOffer: unknown,
    options: ParseOpenSeaBiddingOfferOptions = {},
): ParsedOpenSeaBiddingOffer | null {
    if (!rawOffer) {
        return null;
    }

    const record = asRecord(rawOffer);
    const orderHash = getOpenSeaOrderHash(rawOffer);
    if (!orderHash) {
        return null;
    }

    const maker =
        stringOrUndefined(asRecord(record.maker).address) ??
        stringOrUndefined(record.maker) ??
        stringOrUndefined(getOpenSeaProtocolParameters(rawOffer).offerer);
    if (!maker) {
        return null;
    }

    const extracted = extractOpenSeaWethUnitPrice(rawOffer, options);
    if (!extracted) {
        return null;
    }

    const protocolAddress =
        stringOrUndefined(record.protocolAddress) ??
        stringOrUndefined(record.protocol_address);
    const protocolParameters = getOpenSeaProtocolParameters(rawOffer);
    const createdAt = normalizeOpenSeaTimestamp(
        record.createdAt ??
            record.created_at ??
            record.createdDate ??
            record.created_date,
    );
    const validFrom =
        tryParseNumber(
            record.startTime ??
                record.start_time ??
                protocolParameters?.startTime ??
                protocolParameters?.start_time,
        ) ??
        tryParseTimestamp(createdAt) ??
        undefined;
    const expirationTime =
        tryParseNumber(
            record.expirationTime ??
                record.expiration_time ??
                record.closingDate ??
                record.closing_date ??
                record.endDate ??
                record.end_date ??
                protocolParameters?.endTime ??
                protocolParameters?.end_time,
        ) ??
        tryParseTimestamp(
            record.expirationTime ??
                record.expiration_time ??
                record.closingDate ??
                record.closing_date ??
                record.endDate ??
                record.end_date,
        ) ??
        undefined;

    return {
        id: orderHash,
        price: extracted.price,
        maker: maker.toLowerCase(),
        collectionAddress: getOpenSeaCollectionAddress(
            rawOffer,
            options.collectionAddress,
        ),
        currencyAddress: extracted.currencyAddress,
        protocolAddress,
        createdAt,
        validFrom,
        expirationTime,
        criteriaRoot: getOpenSeaCriteriaRoot(
            rawOffer,
            options.collectionAddress,
        ),
        rawOrder: rawOffer,
        offerScope: inferOpenSeaOfferScope(rawOffer),
        discoverySource: options.discoverySource ?? "collectionOffers",
        priceSource: extracted.source,
        source: extracted.source,
        quantity: extracted.quantity,
        bidScope: resolveOpenSeaBiddingOfferBidScope(
            rawOffer,
            options.collectionAddress,
        ),
    };
}

// Extracts the unit WETH price; partial multi-quantity offers are divided by NFT units.
export function extractOpenSeaWethUnitPrice(
    rawOrder: unknown,
    options: {
        collectionAddress?: string;
        wethAddress?: string;
    } = {},
): OpenSeaBiddingPriceExtraction | null {
    const wethAddress =
        options.wethAddress?.toLowerCase() ??
        OPENSEA_MAINNET_SECURITY_POLICY.wethAddress.toLowerCase();
    const parameters = getOpenSeaProtocolParameters(rawOrder);
    if (getOpenSeaProtocolEnvelope(rawOrder)?.parameters) {
        const offerSum = sumTokenItems(parameters.offer, wethAddress);
        const considerationSum = sumTokenItems(
            parameters.consideration,
            wethAddress,
        );
        const nftUnitsFromConsideration = sumNftUnits(
            parameters.consideration,
            options.collectionAddress,
        );
        const nftUnitsFromOffer = sumNftUnits(
            parameters.offer,
            options.collectionAddress,
        );
        const nftUnits =
            nftUnitsFromConsideration > 0n
                ? nftUnitsFromConsideration
                : nftUnitsFromOffer;
        const orderType = parameters.orderType ?? parameters.order_type;
        const remainingQuantityRaw =
            asRecord(rawOrder).remainingQuantity ??
            asRecord(rawOrder).remaining_quantity;
        const remainingQuantity = tryParseNumber(remainingQuantityRaw);
        const isPartial =
            isPartialOrderType(orderType) ||
            (remainingQuantity !== null && remainingQuantity > 1);

        if (offerSum > 0n || considerationSum > 0n) {
            const total =
                offerSum >= considerationSum
                    ? { value: offerSum, source: "protocol.offer" }
                    : {
                          value: considerationSum,
                          source: "protocol.consideration",
                      };

            const quantity = nftUnits > 0n ? nftUnits : 1n;
            if (isPartial && quantity > 1n) {
                return {
                    price: divCeil(total.value, quantity),
                    source: `${total.source}/unit`,
                    quantity,
                    currencyAddress: wethAddress,
                };
            }

            return {
                price: total.value,
                source: total.source,
                quantity,
                currencyAddress: wethAddress,
            };
        }
    }

    const priceRecord = asRecord(asRecord(rawOrder).price);
    const priceValue = tryParseBigInt(priceRecord.value);
    const priceCurrency = stringOrUndefined(priceRecord.currency);
    if (
        priceValue !== null &&
        priceCurrency &&
        isWethCurrency(priceCurrency, wethAddress)
    ) {
        return {
            price: priceValue,
            source: "price.value",
            quantity: 1n,
            currencyAddress: wethAddress,
        };
    }

    if (!isOpenSeaWethOrder(rawOrder, wethAddress)) {
        return null;
    }

    const currentPriceRaw =
        asRecord(rawOrder).currentPrice ?? asRecord(rawOrder).current_price;
    const currentPrice = tryParseBigInt(currentPriceRaw);
    if (currentPrice !== null) {
        return {
            price: currentPrice,
            source: "currentPrice",
            quantity: 1n,
            currencyAddress: wethAddress,
        };
    }

    return null;
}

// Resolves the bid-book display scope from raw OpenSea criteria and Seaport NFT items.
export function resolveOpenSeaBiddingOfferBidScope(
    rawOffer: unknown,
    collectionAddress?: string,
): OpenSeaBiddingOfferBidScope {
    const criteria = getOpenSeaOfferCriteria(rawOffer);
    const traits = normalizeOpenSeaOfferTraitCriteria(criteria);
    const encodedTokenIds = getEncodedTokenIds(criteria);
    const explicitTokenId = getExplicitTokenId(rawOffer, collectionAddress);

    if (explicitTokenId) {
        return {
            kind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
            label: formatTradingBiddingBidScopeLabel({
                kind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                tokenId: explicitTokenId,
            }),
            tokenId: explicitTokenId,
            traits: [],
            encodedTokenIds: null,
        };
    }

    if (traits.length > 0) {
        return {
            kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
            label: formatTradingBiddingBidScopeLabel({
                kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
                traits,
            }),
            tokenId: null,
            traits,
            encodedTokenIds: encodedTokenIds ?? null,
        };
    }

    if (encodedTokenIds && encodedTokenIds !== "*") {
        return {
            kind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
            label: formatTradingBiddingBidScopeLabel({
                kind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
            }),
            tokenId: null,
            traits: [],
            encodedTokenIds,
        };
    }

    if (criteria || hasCriteriaNftItem(rawOffer, collectionAddress)) {
        return {
            kind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            label: formatTradingBiddingBidScopeLabel({
                kind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            }),
            tokenId: null,
            traits: [],
            encodedTokenIds: encodedTokenIds ?? null,
        };
    }

    return {
        kind: TRADING_BIDDING_BID_SCOPE_KIND.Unknown,
        label: formatTradingBiddingBidScopeLabel({
            kind: TRADING_BIDDING_BID_SCOPE_KIND.Unknown,
        }),
        tokenId: null,
        traits: [],
        encodedTokenIds: null,
    };
}

// Returns the raw OpenSea criteria object from either REST or SDK-shaped order envelopes.
export function getOpenSeaOfferCriteria(
    rawOffer: unknown,
): Record<string, unknown> | undefined {
    const offer = asRecord(rawOffer);
    return (
        recordOrUndefined(offer.criteria) ??
        recordOrUndefined(getOpenSeaProtocolEnvelope(rawOffer)?.criteria) ??
        getOpenSeaStreamTraitCriteria(offer)
    );
}

// Infers the bidder's coarse offer scope from raw criteria and NFT item shape.
export function inferOpenSeaOfferScope(
    rawOrder: unknown,
): OpenSeaBiddingOfferScope {
    const nftSelectionKind = inferOpenSeaNftSelectionKind(rawOrder);
    // An explicit NFT leg remains an item offer even when the response also
    // carries an empty or descriptive criteria object.
    if (nftSelectionKind === "item") return "item";
    const criteria = getOpenSeaOfferCriteria(rawOrder);
    if (criteria) {
        const criteriaTraits = normalizeOpenSeaOfferTraitCriteria(criteria);
        if (criteriaTraits.length > 0) {
            return "trait";
        }

        const encodedIds = getEncodedTokenIds(criteria);
        if (typeof encodedIds === "string" && encodedIds.length > 0) {
            return "collection";
        }

        return "collection";
    }

    if (nftSelectionKind === "criteria") {
        return "collection";
    }
    return "item";
}

// Preserve every string and numeric constraint; dropping a range broadens the offer.
export function normalizeOpenSeaOfferTraitCriteria(
    criteria: unknown,
): TradingBiddingTraitCriterion[] {
    // Exact-item responses can carry an empty criteria object. This absence of
    // criteria is distinct from an empty entry inside a declared trait scope.
    if (
        criteria &&
        !Array.isArray(criteria) &&
        typeof criteria === "object" &&
        Object.keys(criteria).length === 0
    )
        return [];
    return dedupeBiddingTraitCriteria(
        normalizeOptionalOpenSeaTraitCriteria(criteria),
    );
}

function normalizeOptionalOpenSeaTraitCriteria(
    criteria: unknown,
): TradingBiddingTraitCriterion[] {
    if (criteria === undefined || criteria === null) return [];
    return normalizeOpenSeaTraitCriteria(criteria);
}

function normalizeOptionalOpenSeaTraitCriterion(
    criteria: unknown,
): TradingBiddingTraitCriterion[] {
    const traits = normalizeOptionalOpenSeaTraitCriteria(criteria);
    // A supplied singular criterion must decode; an empty plural list may
    // legitimately accompany a collection-wide offer.
    if (criteria !== undefined && criteria !== null && traits.length === 0)
        throw new Error("Invalid OpenSea trait criterion");
    return traits;
}

function normalizeOpenSeaTraitCriteria(
    criteria: unknown,
): TradingBiddingTraitCriterion[] {
    if (Array.isArray(criteria)) {
        return criteria.flatMap((entry) => {
            const record = asObject(entry, "OpenSea trait criterion");
            const traits = normalizeOpenSeaTraitCriteria(record);
            if (traits.length === 0)
                throw new Error("Invalid OpenSea trait criterion");
            return traits;
        });
    }

    const candidate = asObject(criteria, "OpenSea trait criteria");
    if (isOpenSeaCriteriaEnvelope(candidate)) {
        // Both aliases may be present. Keep every supplied constraint instead of
        // letting one envelope field hide the other.
        return [
            ...normalizeOptionalOpenSeaTraitCriterion(candidate.trait),
            ...normalizeOptionalOpenSeaTraitCriteria(candidate.traits),
            ...normalizeOpenSeaNumericTraitCriteria(candidate.numeric_traits),
            ...normalizeOpenSeaNumericTraitCriteria(candidate.numericTraits),
        ];
    }

    const type =
        stringOrUndefined(candidate.type) ??
        stringOrUndefined(candidate.trait_type) ??
        stringOrUndefined(candidate.traitType);
    const value =
        candidate.value ??
        candidate.trait_value ??
        candidate.traitValue ??
        candidate.trait_name;
    if (candidate.min !== undefined || candidate.max !== undefined) {
        return parseBiddingTraitCriteria([
            { type, value, min: candidate.min, max: candidate.max },
        ]);
    }

    if (
        "type" in candidate ||
        "trait_type" in candidate ||
        "traitType" in candidate ||
        "value" in candidate ||
        "trait_value" in candidate ||
        "traitValue" in candidate ||
        "trait_name" in candidate
    ) {
        return parseBiddingTraitCriteria([
            { type, value: openSeaTraitValue(value) },
        ]);
    }

    const entries = Object.entries(candidate);
    if (entries.length === 0) throw new Error("Invalid OpenSea trait criteria");
    return parseBiddingTraitCriteria(
        entries.map(([type, value]) => ({
            type,
            value: openSeaTraitValue(value),
        })),
    );
}

function openSeaTraitValue(value: unknown): string {
    if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    )
        return String(value);
    throw new Error("Invalid OpenSea trait value");
}

// Checks the bidder's collection-wide semantics for OpenSea criteria offers.
export function isOpenSeaCollectionWideOffer(rawOffer: unknown): boolean {
    const nftSelectionKind = inferOpenSeaNftSelectionKind(rawOffer);
    if (nftSelectionKind === "item") {
        return false;
    }

    const criteria = getOpenSeaOfferCriteria(rawOffer);
    const criteriaTraits = normalizeOpenSeaOfferTraitCriteria(criteria);
    const encodedIds = getEncodedTokenIds(criteria);

    return criteriaTraits.length === 0 && (!encodedIds || encodedIds === "*");
}

// Infers whether the Seaport NFT leg targets an exact item or criteria.
export function inferOpenSeaNftSelectionKind(
    rawOrder: unknown,
    collectionAddress?: string,
): "item" | "criteria" | "unknown" {
    const nftItems = getOpenSeaNftItems(rawOrder, collectionAddress);
    if (nftItems.length === 0) {
        return "unknown";
    }

    const hasExplicitItem = nftItems.some((item) =>
        [2, 3].includes(readItemType(item)),
    );
    if (hasExplicitItem) {
        return "item";
    }

    const hasCriteriaItem = nftItems.some((item) =>
        [4, 5].includes(readItemType(item)),
    );
    if (hasCriteriaItem) {
        return "criteria";
    }

    return "unknown";
}

// Returns the NFT contract address targeted by the OpenSea offer, when present.
export function getOpenSeaCollectionAddress(
    rawOffer: unknown,
    collectionAddress?: string,
): string | null {
    const nftItem = getOpenSeaNftItems(rawOffer, collectionAddress)[0];
    const token = stringOrUndefined(asRecord(nftItem).token);
    if (token) {
        return token.toLowerCase();
    }

    const criteria = getOpenSeaOfferCriteria(rawOffer);
    const criteriaContract = recordOrUndefined(criteria?.contract);
    const criteriaAddress = stringOrUndefined(criteriaContract?.address);
    if (criteriaAddress) {
        return criteriaAddress.toLowerCase();
    }

    const assetContractCriteria = recordOrUndefined(
        asRecord(rawOffer).assetContractCriteria ??
            asRecord(rawOffer).asset_contract_criteria,
    );
    const assetCriteriaAddress = stringOrUndefined(
        assetContractCriteria?.address,
    );
    if (assetCriteriaAddress) {
        return assetCriteriaAddress.toLowerCase();
    }

    return collectionAddress?.toLowerCase() ?? null;
}

// Returns the Seaport criteria root for criteria-scoped NFT offer legs.
export function getOpenSeaCriteriaRoot(
    rawOffer: unknown,
    collectionAddress?: string,
): string | null {
    for (const item of getOpenSeaNftItems(rawOffer, collectionAddress)) {
        if (![4, 5].includes(readItemType(item))) {
            continue;
        }
        return readIdentifierOrCriteria(item) ?? null;
    }
    return null;
}

function normalizeOpenSeaNumericTraitCriteria(
    value: unknown,
): TradingBiddingTraitCriterion[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value))
        throw new Error("Invalid OpenSea numeric criteria");
    return value.map((entry): TradingBiddingTraitCriterion => {
        const record = asRecord(entry);
        const type =
            stringOrUndefined(record.type) ??
            stringOrUndefined(record.trait_type) ??
            stringOrUndefined(record.traitType);
        if (record.min !== undefined || record.max !== undefined) {
            const [range] = parseBiddingTraitCriteria([
                { type, min: record.min, max: record.max },
            ]);
            if ("min" in range && range.min === range.max) {
                return { type: range.type, value: String(range.min) };
            }
            return range;
        }
        const exactValue =
            record.value ?? record.trait_value ?? record.traitValue;

        if (
            exactValue === undefined ||
            exactValue === null ||
            numericTraitValue(String(exactValue)) === null
        ) {
            throw new Error("Invalid OpenSea numeric criterion");
        }
        return parseBiddingTraitCriteria([
            { type, value: String(exactValue) },
        ])[0];
    });
}

function getOpenSeaStreamTraitCriteria(
    offer: Record<string, unknown>,
): Record<string, unknown> | undefined {
    const traits = dedupeBiddingTraitCriteria([
        ...normalizeOptionalOpenSeaTraitCriterion(
            offer.trait_criteria ?? offer.traitCriteria,
        ),
        ...normalizeOptionalOpenSeaTraitCriteria(
            offer.trait_criteria_list ?? offer.traitCriteriaList,
        ),
    ]);
    return traits.length > 0 ? { traits } : undefined;
}

function getExplicitTokenId(
    rawOffer: unknown,
    collectionAddress?: string,
): string | null {
    for (const item of getOpenSeaNftItems(rawOffer, collectionAddress)) {
        if (![2, 3].includes(readItemType(item))) {
            continue;
        }
        const tokenId = readIdentifierOrCriteria(item);
        if (tokenId) {
            return tokenId;
        }
    }
    return null;
}

function hasCriteriaNftItem(
    rawOffer: unknown,
    collectionAddress?: string,
): boolean {
    return getOpenSeaNftItems(rawOffer, collectionAddress).some((item) =>
        [4, 5].includes(readItemType(item)),
    );
}

function getOpenSeaNftItems(
    rawOrder: unknown,
    collectionAddress?: string,
): unknown[] {
    const parameters = getOpenSeaProtocolParameters(rawOrder);
    const candidateBuckets = [
        asArray(parameters.consideration),
        asArray(parameters.offer),
    ];

    for (const items of candidateBuckets) {
        const nftItems = items.filter((item) => {
            const itemType = readItemType(item);
            if (![2, 3, 4, 5].includes(itemType)) {
                return false;
            }

            if (!collectionAddress) {
                return true;
            }

            const token = stringOrUndefined(asRecord(item).token);
            return (
                typeof token === "string" &&
                token.toLowerCase() === collectionAddress.toLowerCase()
            );
        });

        if (nftItems.length > 0) {
            return nftItems;
        }
    }

    return [];
}

function isOpenSeaWethOrder(rawOrder: unknown, wethAddress: string): boolean {
    const order = asRecord(rawOrder);
    const paymentToken =
        stringOrUndefined(order.paymentToken) ??
        stringOrUndefined(order.payment_token) ??
        stringOrUndefined(order.paymentTokenAddress) ??
        stringOrUndefined(order.payment_token_address);

    if (paymentToken?.toLowerCase() === wethAddress) {
        return true;
    }

    const parameters = getOpenSeaProtocolParameters(rawOrder);
    const offerItems = asArray(parameters.offer);
    if (
        offerItems.some(
            (item) =>
                stringOrUndefined(asRecord(item).token)?.toLowerCase() ===
                wethAddress,
        )
    ) {
        return true;
    }

    const considerationItems = asArray(parameters.consideration);
    return considerationItems.some(
        (item) =>
            stringOrUndefined(asRecord(item).token)?.toLowerCase() ===
            wethAddress,
    );
}

function isWethCurrency(currency: string, wethAddress: string): boolean {
    const normalized = currency.toLowerCase();
    return normalized === wethAddress || normalized === "weth";
}

function sumTokenItems(items: unknown, tokenAddress: string): bigint {
    if (!Array.isArray(items)) {
        return 0n;
    }

    let sum = 0n;
    for (const item of items) {
        const token = stringOrUndefined(asRecord(item).token);
        if (!token || token.toLowerCase() !== tokenAddress) {
            continue;
        }

        const amount = tryParseBigInt(readAmount(item));
        if (amount === null) {
            continue;
        }

        sum += amount;
    }

    return sum;
}

function sumNftUnits(items: unknown, collectionAddress?: string): bigint {
    if (!Array.isArray(items)) {
        return 0n;
    }

    let sum = 0n;
    for (const item of items) {
        const itemType = readItemType(item);
        if (![2, 3, 4, 5].includes(itemType)) {
            continue;
        }

        const token = stringOrUndefined(asRecord(item).token);
        if (
            collectionAddress &&
            token &&
            token.toLowerCase() !== collectionAddress.toLowerCase()
        ) {
            continue;
        }

        const amount = tryParseBigInt(readAmount(item));
        if (amount === null) {
            continue;
        }

        sum += amount;
    }

    return sum;
}

function isPartialOrderType(orderType: unknown): boolean {
    if (typeof orderType === "number") {
        return orderType === 1 || orderType === 3;
    }
    if (typeof orderType === "string") {
        const upper = orderType.toUpperCase();
        return upper.includes("PARTIAL") || upper === "1" || upper === "3";
    }
    return false;
}

function getEncodedTokenIds(
    criteria: Record<string, unknown> | undefined,
): string | undefined {
    return (
        stringOrUndefined(criteria?.encoded_token_ids) ??
        stringOrUndefined(criteria?.encodedTokenIds)
    );
}

function isOpenSeaCriteriaEnvelope(record: Record<string, unknown>): boolean {
    return (
        "trait" in record ||
        "traits" in record ||
        "numeric_traits" in record ||
        "numericTraits" in record ||
        "encoded_token_ids" in record ||
        "encodedTokenIds" in record ||
        "collection" in record ||
        "contract" in record
    );
}

function readItemType(item: unknown): number {
    return Number(asRecord(item).itemType ?? asRecord(item).item_type);
}

function readIdentifierOrCriteria(item: unknown): string | undefined {
    return (
        stringOrUndefined(asRecord(item).identifierOrCriteria) ??
        stringOrUndefined(asRecord(item).identifier_or_criteria)
    );
}

function readAmount(item: unknown): unknown {
    return (
        asRecord(item).startAmount ??
        asRecord(item).start_amount ??
        asRecord(item).amount
    );
}

function divCeil(numerator: bigint, denominator: bigint): bigint {
    if (denominator === 0n) {
        throw new Error("Division by zero");
    }

    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    return remainder === 0n ? quotient : quotient + 1n;
}

function tryParseBigInt(value: unknown): bigint | null {
    if (value === null || value === undefined) {
        return null;
    }

    try {
        return BigInt(value as bigint | boolean | number | string);
    } catch {
        return null;
    }
}

function tryParseNumber(value: unknown): number | null {
    if (value === null || value === undefined) {
        return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function tryParseTimestamp(value: unknown): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function normalizeOpenSeaTimestamp(value: unknown): string | null {
    const seconds = tryParseTimestamp(value);
    return seconds === null ? null : toRfc3339Seconds(seconds * 1000);
}

function toRfc3339Seconds(ms: number): string {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function recordOrUndefined(
    value: unknown,
): Record<string, unknown> | undefined {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
