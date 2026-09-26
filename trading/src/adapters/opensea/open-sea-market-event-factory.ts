import {
    MarketEvent,
    Scope,
    TraitCriterion,
    Type,
} from "../../domain/market/event.js";
import {
    getOpenSeaEventNft,
    getOpenSeaEventType,
    getOpenSeaOrderHash,
    getOpenSeaPayload as getPayload,
    OPENSEA_STREAM_EVENT_TYPE,
} from "@artgod/shared/opensea/payload";
import {
    asRecord,
    tryParseAddress,
} from "@artgod/shared/offchain/normalizer-utils";

// OpenSeaMarketEventFactory translates raw OpenSea stream payloads into the stable MarketEvent shape.
export class OpenSeaMarketEventFactory {
    private readonly eventTypeMapping: Record<
        string,
        (event: unknown) => MarketEvent
    > = {
        [OPENSEA_STREAM_EVENT_TYPE.CollectionOffer]: (event) =>
            this.mapCollectionOfferEvent(event),
        [OPENSEA_STREAM_EVENT_TYPE.ItemListed]: (event) =>
            this.mapItemListedEvent(event),
        [OPENSEA_STREAM_EVENT_TYPE.ItemReceivedBid]: (event) =>
            this.mapItemReceivedBidEvent(event),
        [OPENSEA_STREAM_EVENT_TYPE.ItemSold]: (event) =>
            this.mapItemSoldEvent(event),
        [OPENSEA_STREAM_EVENT_TYPE.ItemTransferred]: (event) =>
            this.mapItemTransferredEvent(event),
        [OPENSEA_STREAM_EVENT_TYPE.TraitOffer]: (event) =>
            this.mapTraitOfferEvent(event),
    };

    public newMarketEvent(event: unknown): MarketEvent | null {
        const eventType = getOpenSeaEventType(event);
        if (!eventType) {
            return null;
        }

        const typeBuilder = this.eventTypeMapping[eventType];
        if (!typeBuilder) {
            return null;
        }

        return typeBuilder(event);
    }

    public mapCollectionOfferEvent(event: unknown): MarketEvent {
        const marketEvent = this.makeFromTradeEvent(
            event,
            Scope.Collection,
            "",
            this.extractTraitCriteria(event),
        );
        marketEvent.setTotalPrice(
            bigintInputOrZero(getPayload(event).base_price),
        );
        return marketEvent;
    }

    public mapItemListedEvent(event: unknown): MarketEvent {
        const marketEvent = this.makeFromTradeEvent(
            event,
            Scope.Unknown,
            this.mapIdentifier(event),
        );
        marketEvent.setTotalPrice(
            bigintInputOrZero(getPayload(event).base_price),
        );
        return marketEvent;
    }

    public mapItemReceivedBidEvent(event: unknown): MarketEvent {
        const marketEvent = this.makeFromTradeEvent(
            event,
            Scope.Item,
            this.mapIdentifier(event),
        );
        marketEvent.setTotalPrice(
            bigintInputOrZero(getPayload(event).base_price),
        );
        return marketEvent;
    }

    public mapItemSoldEvent(event: unknown): MarketEvent {
        const marketEvent = this.makeFromTradeEvent(
            event,
            Scope.Unknown,
            this.mapIdentifier(event),
        );
        marketEvent.setTotalPrice(
            bigintInputOrZero(getPayload(event).sale_price),
        );
        return marketEvent;
    }

    public mapTraitOfferEvent(event: unknown): MarketEvent {
        const marketEvent = this.makeFromTradeEvent(
            event,
            Scope.Trait,
            "",
            this.extractTraitCriteria(event),
        );
        marketEvent.setTotalPrice(
            bigintInputOrZero(getPayload(event).base_price),
        );
        return marketEvent;
    }

    public mapItemTransferredEvent(event: unknown): MarketEvent {
        const payload = getPayload(event);
        return new MarketEvent(
            stringOrEmpty(payload.event_timestamp),
            Type.ItemTransferred,
            "",
            getCollectionSlug(event),
            this.mapIdentifier(event),
            "",
            numberOrZero(payload.quantity),
            "",
            0,
            Scope.Unknown,
        );
    }

    private makeFromTradeEvent(
        event: unknown,
        scope: Scope,
        itemId: string,
        traitCriteria: TraitCriterion[] = [],
    ): MarketEvent {
        const payload = getPayload(event);
        const paymentToken = asRecord(payload.payment_token);
        return new MarketEvent(
            stringOrEmpty(payload.event_timestamp),
            (getOpenSeaEventType(event) ?? "") as Type,
            getOpenSeaOrderHash(payload) ?? "",
            getCollectionSlug(event),
            itemId,
            tryParseAddress(payload.maker) ?? "",
            numberOrZero(payload.quantity),
            stringOrEmpty(paymentToken.symbol),
            numberOrZero(paymentToken.decimals),
            scope,
            traitCriteria,
            stringOrUndefined(paymentToken.address),
            booleanOrUndefined(payload.is_private),
        );
    }

    private normalizeTraitCriteria(criteria: unknown): TraitCriterion[] {
        if (!criteria) {
            return [];
        }

        if (Array.isArray(criteria)) {
            return criteria.flatMap((entry) =>
                this.normalizeTraitCriteria(entry),
            );
        }

        const record = asRecord(criteria);
        if (record.trait || record.traits) {
            return this.normalizeTraitCriteria(record.trait ?? record.traits);
        }

        const type =
            stringOrUndefined(record.type) ??
            stringOrUndefined(record.trait_type);
        const value = record.value ?? record.trait_value ?? record.trait_name;
        if (typeof type === "string" && value !== undefined && value !== null) {
            return [{ type, value: String(value) }];
        }

        if (typeof criteria === "object" && criteria !== null) {
            const normalized: TraitCriterion[] = [];
            for (const [key, rawValue] of Object.entries(
                criteria as Record<string, unknown>,
            )) {
                if (
                    rawValue === undefined ||
                    rawValue === null ||
                    typeof rawValue === "object"
                ) {
                    continue;
                }
                normalized.push({ type: key, value: String(rawValue) });
            }
            return normalized;
        }

        return [];
    }

    private extractTraitCriteria(event: unknown): TraitCriterion[] {
        const payload = getPayload(event);
        return this.normalizeTraitCriteria(
            payload.trait_criteria_list ?? payload.trait_criteria,
        );
    }

    private mapIdentifier(event: unknown): string {
        return getOpenSeaEventNft(event)?.tokenId ?? "";
    }
}

function getCollectionSlug(event: unknown): string {
    return stringOrEmpty(asRecord(getPayload(event).collection).slug);
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function stringOrEmpty(value: unknown): string {
    return stringOrUndefined(value) ?? "";
}

function numberOrZero(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function bigintInputOrZero(value: unknown): string | bigint {
    return typeof value === "string" || typeof value === "bigint" ? value : 0n;
}
