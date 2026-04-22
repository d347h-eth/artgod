import { formatPrice } from "../../utils/price-format.js";

export enum Type {
    CollectionOffer = "collection_offer",
    ItemListed = "item_listed",
    ItemReceivedBid = "item_received_bid",
    ItemSold = "item_sold",
    TraitOffer = "trait_offer",
    ItemTransferred = "item_transferred",
}

export enum Scope {
    Collection = "collection",
    Item = "item",
    Trait = "trait",
    Unknown = "unknown",
}

export interface TraitCriterion {
    type: string;
    value: string;
}

// MarketEvent is the core hot-path event shape used by bidding refresh logic.
export class MarketEvent {
    private totalPrice: bigint = 0n;

    constructor(
        private readonly createdAt: string,
        private readonly type: Type,
        private readonly orderHash: string,
        private readonly collectionSlug: string,
        private readonly itemId: string,
        private readonly maker: string,
        private readonly quantity: number,
        private readonly paymentTokenSymbol: string,
        private readonly paymentTokenDecimals: number,
        private readonly scope: Scope = Scope.Unknown,
        private readonly traitCriteria: TraitCriterion[] = [],
        private readonly paymentTokenAddress?: string,
        private readonly isPrivate?: boolean,
    ) {}

    public getItemId(): string {
        return this.itemId;
    }

    // Legacy alias kept to minimize downstream adapter churn during the port.
    public getItemID(): string {
        return this.itemId;
    }

    public getCreatedAt(): string {
        return this.createdAt;
    }

    public getType(): Type {
        return this.type;
    }

    public getOrderHash(): string {
        return this.orderHash;
    }

    public getCollectionSlug(): string {
        return this.collectionSlug;
    }

    public getMaker(): string {
        return this.maker;
    }

    public getQuantity(): number {
        return this.quantity;
    }

    public getScope(): Scope {
        return this.scope;
    }

    public getTraitCriteria(): TraitCriterion[] {
        return this.traitCriteria;
    }

    public hasExplicitTokenId(): boolean {
        return this.itemId.length > 0;
    }

    public setTotalPrice(price: string | bigint): void {
        this.totalPrice = typeof price === "bigint" ? price : BigInt(price);
    }

    public getTotalPrice(): bigint {
        return this.totalPrice;
    }

    public getUnitPrice(): bigint {
        if (this.quantity <= 0) {
            return 0n;
        }

        return this.getTotalPrice() / BigInt(this.quantity);
    }

    public getPaymentTokenSymbol(): string {
        return this.paymentTokenSymbol;
    }

    public getPaymentTokenDecimals(): number {
        return this.paymentTokenDecimals;
    }

    public getPaymentTokenAddress(): string | undefined {
        return this.paymentTokenAddress;
    }

    public isPrivateListing(): boolean | undefined {
        return this.isPrivate;
    }

    public getFormattedPrice(): string {
        return formatPrice(this.getUnitPrice(), this.getPaymentTokenDecimals());
    }
}
