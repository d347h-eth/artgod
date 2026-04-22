import { MarketEvent } from "../../../../../domain/market/event.js";
import { EventCallback, WrappingFn } from "../pipeline.js";

type FilterCallback = (event: MarketEvent) => boolean;

// AttrFilter forwards a market event only when at least one configured predicate matches.
export class AttrFilter {
    private readonly filters: Record<string, FilterCallback> = {};

    constructor(private readonly name: string) {}

    public getName(): string {
        return this.name;
    }

    public getWrappingFn(): WrappingFn {
        return (callback: EventCallback): EventCallback => {
            return async (marketEvent: MarketEvent) => {
                if (this.matchFilters(marketEvent)) {
                    await callback(marketEvent);
                }
            };
        };
    }

    public addCriteria(name: string, filter: FilterCallback): void {
        this.filters[name] = filter;
    }

    private matchFilters(marketEvent: MarketEvent): boolean {
        for (const filter of Object.values(this.filters)) {
            if (filter(marketEvent)) {
                return true;
            }
        }
        return false;
    }
}
