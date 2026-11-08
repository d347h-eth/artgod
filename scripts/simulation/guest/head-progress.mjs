import assert from "node:assert/strict";

export const HEAD_PROGRESS_EVENT = Object.freeze({
    Advance: "head-progress",
    Cut: "head-progress-cut",
});
export const HEAD_PROGRESS_PROPERTY = Object.freeze({
    Contract: "bounded-head-progress-contract",
    Exhausted: "bounded-head-progress-exhausted",
});
const POLL_MS = 1_000;

/** A finite external chain producer. Every header comes from the immutable ledger. */
export function createHeadProgress({
    world,
    ledger,
    maximumHead,
    providers,
    now = Date.now,
    schedule = setInterval,
    cancel = clearInterval,
}) {
    assert.ok(
        Number.isSafeInteger(maximumHead) && maximumHead <= ledger.maximumBlock,
        "Head progress needs an explicit ceiling inside the external ledger",
    );
    assert.ok(
        providers.length > 0 && new Set(providers).size === providers.length,
    );
    let active = false;
    let started = false;
    let timer;
    let failure;
    let cut;
    const events = [];
    const view = () => {
        const first = world.providerView(providers[0]);
        for (const provider of providers)
            assert.deepEqual(
                world.providerView(provider),
                first,
                "Automatic progress requires an explicitly coherent provider view",
            );
        assert.ok(
            first.head <= maximumHead,
            "A head producer cannot shrink its published chain",
        );
        return first;
    };
    const record = (event) => {
        events.push(event);
        world.recordExternal(event);
    };
    const advance = () => {
        if (!active) return;
        const current = view();
        let head = current.head;
        let block = ledger.blockAt(current.branch, head);
        const time = Math.floor(now() / 1000);
        assert.ok(
            block.timestamp <= time,
            "The producer cannot start from a future published header",
        );
        if (head === maximumHead) {
            const interval =
                block.timestamp -
                ledger.blockAt(current.branch, head - 1).timestamp;
            if (time >= block.timestamp + interval)
                throw Object.assign(
                    new Error(
                        "The declared finite head-progress history is exhausted",
                    ),
                    { property: HEAD_PROGRESS_PROPERTY.Exhausted },
                );
            return;
        }
        while (head < maximumHead) {
            const next = ledger.blockAt(current.branch, head + 1);
            assert.equal(
                next.parentHash,
                block.hash,
                "Head progress cannot splice a different parent",
            );
            assert.ok(
                next.timestamp > block.timestamp,
                "Head progress requires increasing immutable timestamps",
            );
            if (next.timestamp > time) break;
            head++;
            block = next;
        }
        if (head !== current.head) {
            world.advanceHead(head);
            record({
                type: HEAD_PROGRESS_EVENT.Advance,
                branch: current.branch,
                previousHead: current.head,
                head,
                hash: block.hash,
                timestamp: block.timestamp,
                publishedAt: time,
            });
        }
    };
    const tick = () => {
        try {
            advance();
        } catch (error) {
            error.property ??= HEAD_PROGRESS_PROPERTY.Contract;
            failure = error;
            active = false;
            if (timer !== undefined) cancel(timer);
        }
    };
    return {
        start() {
            assert.equal(
                started,
                false,
                "An external head producer can start only once",
            );
            started = active = true;
            tick();
            if (failure) throw failure;
            timer = schedule(tick, POLL_MS);
            timer.unref?.();
        },
        assertHealthy() {
            if (failure) throw failure;
        },
        stop() {
            if (timer !== undefined) cancel(timer);
            active = false;
            if (!started) return undefined;
            if (!cut) {
                const current = world.providerView(providers[0]);
                const block = ledger.blockAt(current.branch, current.head);
                cut = {
                    type: HEAD_PROGRESS_EVENT.Cut,
                    ...current,
                    hash: block.hash,
                    timestamp: block.timestamp,
                    stoppedAt: Math.floor(now() / 1000),
                    ...(failure ? { failure: failure.message } : {}),
                };
                record(cut);
            }
            return cut;
        },
        evidence() {
            return { started, active, maximumHead, cut, events: [...events] };
        },
    };
}
