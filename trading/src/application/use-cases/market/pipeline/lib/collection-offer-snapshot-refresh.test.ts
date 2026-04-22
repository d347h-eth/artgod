import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { MarketEvent, Scope, Type } from "../../../../../domain/market/event.js";
import { CollectionOfferSnapshotRefresh } from "./collection-offer-snapshot-refresh.js";

class FakeCollectionOfferRefreshPort {
    public calls: Array<{
        collectionSlug: string;
        reason?: string;
        options?: { respectTtl?: boolean };
    }> = [];

    public requestRefresh(): void {}

    public async refreshAndWait(
        collectionSlug: string,
        reason?: string,
        options?: { respectTtl?: boolean },
    ): Promise<void> {
        this.calls.push({ collectionSlug, reason, options });
    }
}

function sampleEvent(): MarketEvent {
    const event = new MarketEvent(
        new Date().toISOString(),
        Type.TraitOffer,
        "0xhash",
        "terraforms",
        "",
        "0xmaker",
        1,
        "WETH",
        18,
        Scope.Trait,
        [{ type: "Biome", value: "53" }],
    );
    event.setTotalPrice(1n);
    return event;
}

describe("CollectionOfferSnapshotRefresh", () => {
    it("refreshes only when the predicate returns a reason and always forwards the event", async () => {
        const refreshPort = new FakeCollectionOfferRefreshPort();
        const forwarded: MarketEvent[] = [];
        const stage = new CollectionOfferSnapshotRefresh(
            "criteria-offer-cache-refresh",
            refreshPort,
            (marketEvent) =>
                marketEvent
                    .getTraitCriteria()
                    .some((criterion) => criterion.type === "Biome")
                    ? "matchedTraits=Biome"
                    : null,
        );

        const wrapped = stage.getWrappingFn()(async (event) => {
            forwarded.push(event);
        });
        const marketEvent = sampleEvent();
        await wrapped(marketEvent);

        assert.deepEqual(refreshPort.calls, [
            {
                collectionSlug: "terraforms",
                reason: "matchedTraits=Biome",
                options: { respectTtl: true },
            },
        ]);
        assert.deepEqual(forwarded, [marketEvent]);
    });
});
