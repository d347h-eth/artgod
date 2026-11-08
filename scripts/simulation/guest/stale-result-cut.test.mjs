import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { encodeFunctionData } from "viem";
import { createSimulationWorld } from "../world/world.mjs";
import { CONTRACT_ABI, wireQuantity } from "../world/wire.mjs";
import { MAKER_REVALIDATION_STATUS } from "../../../indexer/src/domain/maker-revalidation.ts";
import { ORDER_VALIDATION_BATCH_POLICY } from "../../../indexer/src/domain/order-validation-policy.ts";
import { ORDER_SEAPORT_DATA_SOURCE_KIND } from "../../../indexer/src/domain/orders.ts";
import { OFFCHAIN_OBSERVATION_CHANNEL } from "../../../indexer/src/domain/offchain-jobs.ts";
import {
    MAKER_TRIGGER_SCOPE,
    GLOBAL_MAKER_TRIGGER_REASON,
} from "../../../indexer/src/domain/maker-triggers.ts";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
} from "../../../shared/market-data/orders.ts";
import {
    createStaleResultCut,
    isStaleResultCutUnreached,
    STALE_RESULT_GATE,
    STALE_RESULT_PROPERTY as PROPERTY,
} from "./stale-result-cut.mjs";

// Driver guard tests use real external wire/gates and synthetic read-only
// observations. They do not prove the production worker rejects a stale result.
async function fixture({
    onOldReply,
    durableRelease = true,
    statusBlock = 105,
    finishRead = true,
    freshAdmission = true,
} = {}) {
    const world = createSimulationWorld({
        epochSeconds: 1_000_000,
        providers: { default: { branch: "A", head: 105 } },
    });
    const { ledger } = world;
    let time = ledger.epochSeconds * 1000 + 10_000;
    const state = {
        revision: 0,
        recovery: [],
        coverage: [],
        headers: [],
        canonicalChecks: [],
        observations: [],
        orders: [
            {
                id: ledger.orders.bid.orderHash,
                state_revision: 3,
                source_status: ORDER_SOURCE_STATUS.Active,
                fillability_status: ORDER_STATUS.Fillable,
                validated_at: time - 3000,
                seaport_data_source_kind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
            },
        ],
        validationProofs: [
            {
                order_id: ledger.orders.bid.orderHash,
                generation: 1,
                pending: 1,
                proof_revision: 3,
                proof_at: time - 3000,
                proof_block: 103,
                proof_chain_revision: 0,
            },
        ],
        makerRuns: [
            {
                run_id: "actual-opaque-run",
                chain_id: ledger.chainId,
                source_job_id: "opaque-origin",
                payload_json: JSON.stringify({
                    chainId: ledger.chainId,
                    scope: MAKER_TRIGGER_SCOPE.Global,
                    reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
                    maker: ledger.addresses.bidder,
                    blockNumber: 105,
                    blockHash: ledger.blockAt("A", 105).hash,
                }),
                status: MAKER_REVALIDATION_STATUS.Pending,
                after_id: "",
                upper_order_id:
                    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                upper_rowid: 2,
                lease_owner: "actual-opaque-lease",
                lease_version: 1,
                lease_until: time + 120_000,
                pass_started_at: time - 1000,
                step: 0,
                resolved_orders: 0,
                deferred_orders: 0,
                generation: 1,
                pass_generation: 1,
                failures: 0,
                last_error: null,
                updated_at: time,
            },
        ],
    };
    const pending = [];
    const track = (promise) => {
        pending.push(promise);
        void promise.catch(() => {});
        return promise;
    };
    const call = (functionName, args, number) =>
        world.handleRpc("default", {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
                {
                    to: ledger.addresses.seaport,
                    data: encodeFunctionData({
                        abi: CONTRACT_ABI,
                        functionName,
                        args,
                    }),
                },
                wireQuantity(number),
            ],
        });
    const controller = createStaleResultCut({
        world,
        ledger,
        observe: () => structuredClone(state),
        assertAlive() {},
        now: () => time,
        admitFreshBidRequirement() {
            if (!freshAdmission) {
                track(
                    call("getOrderStatus", [ledger.orders.bid.orderHash], 107),
                );
                return {
                    sourceEventAt: Math.floor(time / 1000),
                    deliveredRecipients: 1,
                };
            }
            state.orders[0].state_revision++;
            state.orders[0].seaport_data_source_kind =
                ORDER_SEAPORT_DATA_SOURCE_KIND.Stream;
            state.orders[0].validated_at = 0;
            state.validationProofs[0].generation++;
            state.validationProofs[0].pending = 1;
            const sourceEventAt = Math.floor(time / 1000);
            state.observations.push({
                order_id: ledger.orders.bid.orderHash,
                channel: OFFCHAIN_OBSERVATION_CHANNEL.Stream,
                source_event_at: sourceEventAt,
            });
            track(call("getOrderStatus", [ledger.orders.bid.orderHash], 107));
            return { sourceEventAt, deliveredRecipients: 1 };
        },
        async eventually(predicate, label) {
            for (let attempt = 0; attempt < 20; attempt++) {
                if (await predicate()) return;
                await setImmediate();
                time += 10;
            }
            throw new Error(label);
        },
    });
    const startOld = () =>
        track(
            call("getCounter", [ledger.addresses.bidder], statusBlock).then(
                async () => {
                    if (finishRead)
                        await world.handleRpc("default", {
                            jsonrpc: "2.0",
                            id: 3,
                            method: "eth_getBlockByNumber",
                            params: [wireQuantity(105), false],
                        });
                    if (durableRelease) {
                        state.makerRuns[0].failures++;
                        state.makerRuns[0].lease_owner = null;
                        state.makerRuns[0].lease_until = 0;
                    }
                    onOldReply?.(state, world);
                },
            ),
        );
    startOld();
    await world.waitForResponseGate(STALE_RESULT_GATE.OldCounter);
    const rollback = () => {
        world.switchBranch("B", { head: 107 });
        state.revision = 1;
        state.coverage = Array.from({ length: 7 }, (_, i) => ({
            block_number: 101 + i,
        }));
        state.headers = state.coverage.map(({ block_number }) => ({
            block_number,
            block_hash: ledger.blockAt("B", block_number).hash,
        }));
    };
    return {
        world,
        ledger,
        state,
        controller,
        rollback,
        startOld,
        setTime: (value) => {
            time = value;
        },
        async close() {
            controller.abort();
            await Promise.allSettled(pending);
            world.close();
        },
    };
}

const prepare = async (f) => {
    await f.controller.captureHeld();
    f.rollback();
    await f.controller.captureRollback();
};

test("the cut observes failed release with an unchanged target/page while actual fresh B replies remain held", async () => {
    const f = await fixture();
    try {
        await prepare(f);
        const result = await f.controller.releaseAndAssertRejected();
        assert.deepEqual(result.reached, {
            heldLiveMakerAttempt: true,
            postRollbackBaseline: true,
            freshSourceRequirementHeld: true,
            durableFailedRelease: true,
            unchangedProjectionAndPage: true,
            freshRepliesReleased: true,
        });
        assert.equal(result.original.lease_version, 1);
        assert.equal(result.afterRejection.makerRuns[0].failures, 1);
        assert.equal(result.afterRejection.makerRuns[0].step, 0);
        const old = result.responseGatesAtCut.find(
            (entry) => entry.name === STALE_RESULT_GATE.OldCounter,
        );
        const fresh = result.responseGatesAtCut.find(
            (entry) => entry.name === STALE_RESULT_GATE.FreshStatus,
        );
        assert.equal(old.captures[0].delivered, true);
        assert.equal(fresh.released, false);
        assert.equal(fresh.captures[0].pending, true);
        assert.equal(fresh.captures[0].view.branch, "B");
        assert.equal(
            fresh.captures[0].matchingCalls[0].args[0],
            f.ledger.orders.bid.orderHash,
        );
    } finally {
        await f.close();
    }
});

test("initial maker-owned work gains a real newer requirement before rejection is tested", async () => {
    const f = await fixture();
    try {
        f.state.validationProofs[0].pending = 0;
        await prepare(f);
        const result = await f.controller.releaseAndAssertRejected();
        assert.equal(result.before.validationProofs[0].pending, 0);
        assert.equal(result.baseline.proof.pending, 1);
        assert.equal(
            result.afterRejection.makerRuns[0].status,
            MAKER_REVALIDATION_STATUS.Pending,
        );
    } finally {
        await f.close();
    }
});

test("the quiet cut holds other fresh Seaport statuses as well as the target bid", async () => {
    const f = await fixture();
    let listingReply;
    try {
        await prepare(f);
        let delivered = false;
        listingReply = f.world
            .handleRpc("default", {
                jsonrpc: "2.0",
                id: 2,
                method: "eth_call",
                params: [
                    {
                        to: f.ledger.addresses.seaport,
                        data: encodeFunctionData({
                            abi: CONTRACT_ABI,
                            functionName: "getOrderStatus",
                            args: [f.ledger.orders.listing.orderHash],
                        }),
                    },
                    wireQuantity(107),
                ],
            })
            .then(() => {
                delivered = true;
            });
        await setImmediate();
        assert.equal(delivered, false);
        const result = await f.controller.releaseAndAssertRejected();
        const held = result.responseGatesAtCut.find(
            (entry) => entry.name === STALE_RESULT_GATE.FreshStatus,
        );
        assert.equal(held.argument, null);
        assert.equal(held.captures.length, 2);
        assert.ok(
            held.captures.every(
                (capture) => capture.pending && !capture.delivered,
            ),
        );
        await listingReply;
        assert.equal(delivered, true);
    } finally {
        await f.close();
        if (listingReply) await listingReply;
    }
});

test("a stale cancellation cannot be masked by a later B validation", async () => {
    const f = await fixture({
        onOldReply: (state) => {
            state.orders[0].fillability_status = ORDER_STATUS.Cancelled;
        },
    });
    try {
        await prepare(f);
        await assert.rejects(
            f.controller.releaseAndAssertRejected(),
            (error) => {
                assert.equal(error.property, PROPERTY.Projection);
                assert.equal(isStaleResultCutUnreached(error), false);
                assert.equal(
                    error.simulation.staleResultCut.responseGates.find(
                        (entry) => entry.name === STALE_RESULT_GATE.FreshStatus,
                    ).released,
                    false,
                );
                return true;
            },
        );
    } finally {
        await f.close();
    }
});

test("old proof publication or discharge of a newer requirement is a failed safety assertion", async () => {
    for (const mutate of [
        (state) => {
            state.validationProofs[0].proof_at++;
        },
        (state) => {
            state.validationProofs[0].pending = 0;
        },
        (state) => {
            state.orders[0].validated_at++;
        },
    ]) {
        const f = await fixture({ onOldReply: mutate });
        try {
            await prepare(f);
            await assert.rejects(
                f.controller.releaseAndAssertRejected(),
                (error) =>
                    error.property === PROPERTY.Projection &&
                    !isStaleResultCutUnreached(error),
            );
        } finally {
            await f.close();
        }
    }
});

test("cursor progression, completed or lost maker ownership cannot pass without a rejected page", async () => {
    for (const mutate of [
        (state) => {
            state.makerRuns[0].step++;
        },
        (state) => {
            state.makerRuns[0].after_id = state.orders[0].id;
        },
        (state) => {
            state.makerRuns[0].status = MAKER_REVALIDATION_STATUS.Completed;
        },
        (state) => {
            state.makerRuns = [];
        },
    ]) {
        const f = await fixture({ onOldReply: mutate });
        try {
            await prepare(f);
            await assert.rejects(
                f.controller.releaseAndAssertRejected(),
                (error) =>
                    error.property === PROPERTY.Retained &&
                    !isStaleResultCutUnreached(error),
            );
        } finally {
            await f.close();
        }
    }
});

test("transport handoff alone never proves that the actual maker attempt rejected its result", async () => {
    const f = await fixture({ durableRelease: false });
    try {
        await prepare(f);
        await assert.rejects(
            f.controller.releaseAndAssertRejected(),
            isStaleResultCutUnreached,
        );
        assert.equal(f.state.makerRuns[0].failures, 0);
    } finally {
        await f.close();
    }
});

test("a failed release without old snapshot verification cannot credit consumption of the old reply", async () => {
    const f = await fixture({ finishRead: false });
    try {
        await prepare(f);
        await assert.rejects(
            f.controller.releaseAndAssertRejected(),
            isStaleResultCutUnreached,
        );
        assert.equal(f.state.makerRuns[0].failures, 1);
        assert.equal(
            f.world
                .snapshot()
                .responseGates.find(
                    (entry) => entry.name === STALE_RESULT_GATE.OldCounter,
                ).captures[0].delivered,
            true,
        );
    } finally {
        await f.close();
    }
});

test("an expired lease or validation lifetime is unreached, not credited rejection", async () => {
    for (const expiration of ["lease", "snapshot", "header"]) {
        const f = await fixture();
        try {
            await f.controller.captureHeld();
            f.rollback();
            if (expiration === "lease")
                f.setTime(f.state.makerRuns[0].lease_until + 1);
            if (expiration === "snapshot")
                f.setTime(
                    f.state.makerRuns[0].pass_started_at +
                        ORDER_VALIDATION_BATCH_POLICY.snapshotLifetimeMs +
                        1,
                );
            if (expiration === "header")
                f.setTime(
                    (f.ledger.blockAt("A", 105).timestamp +
                        ORDER_VALIDATION_BATCH_POLICY.maxBlockAgeSeconds +
                        1) *
                        1000,
                );
            await assert.rejects(
                f.controller.captureRollback(),
                isStaleResultCutUnreached,
            );
            assert.equal(f.world.snapshot().responseGates[0].released, false);
        } finally {
            await f.close();
        }
    }
});

test("an already-ended lease before controlled release cannot claim the captured attempt", async () => {
    const f = await fixture();
    try {
        await f.controller.captureHeld();
        f.rollback();
        f.state.makerRuns[0].lease_version++;
        await assert.rejects(
            f.controller.captureRollback(),
            isStaleResultCutUnreached,
        );
    } finally {
        await f.close();
    }
});

test("wrong-height and ambiguous old replies cannot establish the required prelude", async () => {
    const wrong = await fixture({ statusBlock: 104 });
    try {
        await assert.rejects(
            wrong.controller.captureHeld(),
            isStaleResultCutUnreached,
        );
    } finally {
        await wrong.close();
    }
    const ambiguous = await fixture();
    try {
        ambiguous.startOld();
        await assert.rejects(
            ambiguous.controller.captureHeld(),
            isStaleResultCutUnreached,
        );
    } finally {
        await ambiguous.close();
    }
});

test("a page changed by pre-release recovery is unreached rather than a stale-result mutation", async () => {
    const f = await fixture();
    try {
        await f.controller.captureHeld();
        f.rollback();
        f.state.makerRuns[0].step++;
        await assert.rejects(f.controller.captureRollback(), (error) => {
            assert.equal(isStaleResultCutUnreached(error), true);
            assert.equal(error.property, PROPERTY.Rollback);
            return true;
        });
        assert.equal(
            f.world
                .snapshot()
                .responseGates.find(
                    (entry) => entry.name === STALE_RESULT_GATE.OldCounter,
                ).released,
            false,
        );
    } finally {
        await f.close();
    }
});

test("a reported stream delivery and held B reply do not replace actual newer source/demand admission", async () => {
    const f = await fixture({ freshAdmission: false });
    try {
        await f.controller.captureHeld();
        f.rollback();
        await assert.rejects(
            f.controller.captureRollback(),
            (error) =>
                isStaleResultCutUnreached(error) &&
                error.property === PROPERTY.FreshRequirement,
        );
        assert.equal(
            f.world
                .snapshot()
                .responseGates.find(
                    (entry) => entry.name === STALE_RESULT_GATE.OldCounter,
                ).released,
            false,
        );
    } finally {
        await f.close();
    }
});

test("the baseline is captured only after real B headers, coverage and recovery observations", async () => {
    const f = await fixture();
    try {
        await f.controller.captureHeld();
        f.rollback();
        f.state.headers[4].block_hash = f.ledger.blockAt("A", 105).hash;
        await assert.rejects(
            f.controller.captureRollback(),
            isStaleResultCutUnreached,
        );
    } finally {
        await f.close();
    }
});
