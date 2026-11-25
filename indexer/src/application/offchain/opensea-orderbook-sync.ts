import { normalizeCriteriaRoot } from "@artgod/shared/offchain/normalizer-utils";
import { OPENSEA_MAINNET_SECURITY_POLICY } from "@artgod/shared/trading/open-sea-mainnet-security-policy";
import type { BookPublicationPort } from "../../ports/orderbooks.js";
import type { CollectionRecord } from "../../domain/collections.js";
import { ORDERBOOK_VENUE, ORDER_SIDE } from "@artgod/shared/market-data/orders";
import { zeroAddress } from "viem";
import {
    BOOK_VIEW,
    cashBidAmounts,
    settlementIdentity,
    type BookFeed,
    type BookMarket,
    type BookObservation,
    type BookOrder,
} from "../../domain/orderbook.js";
import { type OpenSeaOrderbookRunKind } from "../../domain/opensea-jobs.js";
import type { OpenSeaRestRecord } from "../../domain/offchain-jobs.js";
import type { NormalizedOffchainOrder } from "./normalize.js";
import { normalizeOpenSeaRestOrder } from "./opensea-rest-normalize.js";
import {
    computeSeaportOrderHash,
    recoverSeaportSigner,
} from "./seaport-protocol.js";
import { extractSeaportSellTerms } from "./seaport-order-data.js";

const OPENSEA_ACTIVE = "active";
const OPENSEA_UNKNOWN_STATUS = "unknown";
type Visit = (record: OpenSeaRestRecord) => Promise<void>;
type OpenSeaOrderbookApiPort = {
    forEachListing(slug: string, contract: string, visit: Visit): Promise<void>;
    forEachOffer(slug: string, contract: string, visit: Visit): Promise<void>;
};
export function openSeaFeed(
    collection: CollectionRecord,
    view: string = BOOK_VIEW.Public,
): BookFeed {
    if (!collection.openseaSlug)
        throw new Error("Missing bound OpenSea market");
    return {
        venue: ORDERBOOK_VENUE.OpenSea,
        reference: collection.openseaSlug,
        chainId: collection.chainId,
        contract: collection.address.toLowerCase(),
        view,
    };
}

export async function openSeaObservation(
    market: BookMarket,
    nativeId: string,
    order: BookOrder | null,
    sourceTime: number | null,
): Promise<BookObservation> {
    const record: BookObservation = {
        nativeId: nativeId.toLowerCase(),
        placement: market,
        settlementId: null,
        status: OPENSEA_ACTIVE,
        fillable: false,
        audience: order?.taker ?? null,
        sourceTime,
        order: null,
        fees: null,
        proceeds: null,
    };
    const data = order?.seaportData;
    if (
        !order ||
        !data ||
        data.offerer !== order.maker.toLowerCase() ||
        BigInt(data.totalOriginalConsiderationItems) !==
            BigInt(data.consideration.length) ||
        order.contract.toLowerCase() !== market.contract ||
        (order.taker && order.taker !== zeroAddress)
    )
        return record;
    // Restricted orders need a recognized public marketplace execution path.
    const open = data.orderType === "0" || data.orderType === "1";
    const signedZone =
        (data.orderType === "2" || data.orderType === "3") &&
        market.chainId === OPENSEA_MAINNET_SECURITY_POLICY.chainId &&
        data.zone === OPENSEA_MAINNET_SECURITY_POLICY.signedZoneAddress;
    if (!open && !signedZone) return record;
    if (order.side === ORDER_SIDE.Buy) {
        const amounts = cashBidAmounts(data);
        if (
            !amounts ||
            amounts.target.token !== market.contract ||
            amounts.target.recipient !== order.maker.toLowerCase()
        )
            return record;
        if (amounts.quantity > 1n && !["1", "3"].includes(data.orderType))
            return record;
        const exactNft =
            amounts.target.itemType === "2" || amounts.target.itemType === "3";
        if (exactNft && amounts.target.identifierOrCriteria !== order.tokenId)
            return record;
        if (!exactNft) {
            // A venue's claimed token ID cannot prove membership in signed criteria.
            if (order.tokenId != null) return record;
            const signedRoot = normalizeCriteriaRoot(
                amounts.target.identifierOrCriteria,
                "signed criteria root",
            );
            if (
                order.sourceCriteriaRoot &&
                order.sourceCriteriaRoot !== signedRoot
            )
                return record;
            order = { ...order, sourceCriteriaRoot: signedRoot };
        }
        record.fees = amounts.fees.toString();
        record.proceeds = amounts.proceeds.toString();
        order = {
            ...order,
            price: amounts.gross.toString(),
            quantity: amounts.quantity.toString(),
            currency: amounts.currency,
        };
    } else {
        const ask = extractSeaportSellTerms(data);
        if (
            !ask ||
            ask.contract !== market.contract ||
            ask.tokenId !== order.tokenId ||
            data.offer.length !== 1 ||
            data.consideration.some((item) => Number(item.itemType) > 1)
        )
            return record;
        const nft = data.offer[0]!;
        const quantity = BigInt(nft.startAmount);
        if (
            !["2", "3"].includes(nft.itemType) ||
            nft.endAmount !== nft.startAmount ||
            quantity <= 0n ||
            (quantity > 1n && !["1", "3"].includes(data.orderType)) ||
            data.consideration.some(
                (item) => BigInt(item.startAmount) % quantity !== 0n,
            )
        )
            return record;
        order = {
            ...order,
            price: (BigInt(ask.price) / quantity).toString(),
            currency: ask.currency,
            quantity: quantity.toString(),
        };
    }
    if (computeSeaportOrderHash(data).toLowerCase() !== record.nativeId)
        return record;
    if (data.signature) {
        if (
            (await recoverSeaportSigner(market.chainId, data)).toLowerCase() !==
            order.maker.toLowerCase()
        )
            return record;
        record.settlementId = settlementIdentity(
            market.chainId,
            data.protocolAddress,
            nativeId,
        );
    } else {
        // Incomplete signing evidence is local to this publication.
        record.settlementId = [
            market.venue,
            market.chainId,
            market.reference,
            data.protocolAddress,
            record.nativeId,
        ].join(":");
    }
    record.fillable = true;
    // Keep the normalized terms only. Stream envelopes include unrelated SDK payloads.
    const { rawPayload, rawSourceKind, chainId, source, ...terms } =
        order as Partial<NormalizedOffchainOrder> & BookOrder;
    record.order = terms;
    return record;
}

export class OpenSeaOrderbookSync {
    constructor(
        private readonly api: OpenSeaOrderbookApiPort,
        private readonly store: BookPublicationPort,
        private readonly bindings: (
            collection: CollectionRecord,
        ) => CollectionRecord[] = (collection) => [collection],
    ) {}
    async syncCollection(
        collection: CollectionRecord,
        _kind: OpenSeaOrderbookRunKind,
        _runId: number,
        requestedAt?: number,
    ) {
        const feed = openSeaFeed(collection);
        for (const scope of this.bindings(collection))
            this.store.bind(feed, scope.id);
        // Separate bootstrap runs can share a completed traversal while each retains
        // its own progress. A scope change requires a read at the new binding revision.
        if (
            requestedAt !== undefined &&
            this.store.alreadyAccepted(feed, requestedAt)
        )
            return { activeOrders: 0, deactivatedOrders: 0 };
        const read = this.store.begin(feed);
        try {
            const visit: Visit = async (raw) => {
                if (!raw.orderId)
                    throw new Error("OpenSea order missing its identity");
                let observation: BookObservation;
                try {
                    observation = await openSeaObservation(
                        feed,
                        raw.orderId,
                        normalizeOpenSeaRestOrder(raw.eventType, raw.payload),
                        raw.sourceEventAt === null
                            ? null
                            : raw.sourceEventAt * 1000,
                    );
                } catch {
                    observation = await openSeaObservation(
                        feed,
                        raw.orderId,
                        null,
                        raw.sourceEventAt === null
                            ? null
                            : raw.sourceEventAt * 1000,
                    );
                }
                // A venue can still list an ID after it stops offering a route.
                // Only absence from a completed traversal removes its membership.
                observation.status =
                    typeof raw.payload.status === "string"
                        ? raw.payload.status.toLowerCase()
                        : OPENSEA_UNKNOWN_STATUS;
                observation.fillable &&=
                    observation.status === OPENSEA_ACTIVE &&
                    (raw.payload.fillable === undefined ||
                        raw.payload.fillable === true);
                read.record(observation);
            };
            await this.api.forEachListing(feed.reference, feed.contract, visit);
            await this.api.forEachOffer(feed.reference, feed.contract, visit);
            return read.publish();
        } catch (error) {
            read.fail(error);
            throw error;
        } finally {
            read.close();
        }
    }
}
