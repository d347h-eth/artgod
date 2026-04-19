import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { StreamListener } from "./stream-listener.js";

class FakeEventStream {
    public callbacks: Array<(event: unknown) => Promise<void>> = [];

    public registerHandler(callback: (event: unknown) => Promise<void>): void {
        this.callbacks.push(callback);
    }
}

describe("StreamListener", () => {
    it("remembers attached handler names and registers the callback on the stream", () => {
        const eventStream = new FakeEventStream();
        const listener = new StreamListener(eventStream as any);

        listener.attachHandler("terraforms-bids", async () => {});

        assert.deepEqual(listener.getRegisteredHandlers(), ["terraforms-bids"]);
        assert.equal(eventStream.callbacks.length, 1);
    });
});
