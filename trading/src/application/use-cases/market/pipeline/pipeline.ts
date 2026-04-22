import { MarketEvent } from "../../../../domain/market/event.js";

export type WrappingFn = (callback: EventCallback) => EventCallback;
export type EventCallback = (event: MarketEvent) => Promise<void>;

export interface EventCallbackBuilder {
    getName(): string;
    getWrappingFn(): WrappingFn;
}

// PipelineBuilder composes market-event stages from outermost to innermost callback.
export class PipelineBuilder {
    private readonly callbackBuilders: EventCallbackBuilder[] = [];

    public with(builder: EventCallbackBuilder): PipelineBuilder {
        this.callbackBuilders.push(builder);
        return this;
    }

    public build(): EventCallback {
        if (this.callbackBuilders.length === 0) {
            throw new Error("Empty processing pipeline for market event");
        }

        let builder = this.callbackBuilders[this.callbackBuilders.length - 1]!;
        let wrappingFn = builder.getWrappingFn();
        let nextFn = wrappingFn.bind(
            builder,
            async (_event: MarketEvent) => {},
        )();

        for (let index = this.callbackBuilders.length - 2; index >= 0; index--) {
            builder = this.callbackBuilders[index]!;
            wrappingFn = builder.getWrappingFn();
            nextFn = wrappingFn.bind(builder, nextFn)();
        }

        return nextFn;
    }
}
