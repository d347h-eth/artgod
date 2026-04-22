import { EventCallback } from "../market/pipeline/pipeline.js";

interface EventStream {
    registerHandler(callback: EventCallback): void;
}

// StreamListener is the small use-case wrapper that binds a named pipeline to one inbound stream.
export class StreamListener {
    private readonly eventFilters: string[] = [];

    constructor(private readonly eventStream: EventStream) {}

    public getRegisteredHandlers(): string[] {
        return this.eventFilters;
    }

    public attachHandler(name: string, eventCallback: EventCallback): void {
        this.rememberFilter(name);
        this.eventStream.registerHandler(eventCallback);
    }

    private rememberFilter(name: string): void {
        this.eventFilters.push(name);
    }
}
