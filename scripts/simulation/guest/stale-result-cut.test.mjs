import {
    RuntimeProcessExit,
    RUNTIME_PROCESS_PROPERTY,
    findRuntimeProcessExit,
} from "./runtime-process.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
    encodeFunctionData,
    decodeFunctionResult,
    createPublicClient,
    custom,
} from "viem";
import { createSimulationWorld } from "../world/world.mjs";
import {
    CONTRACT_ABI,
    wireQuantity,
    ZERO_ADDRESS,
    DEPLOYLESS_MULTICALL3,
} from "../world/wire.mjs";
import { COLLECTION_STANDARD } from "../../../shared/types/browse.ts";
import { REORG_RECOVERY_PHASE } from "../../../indexer/src/domain/reorg-recovery.ts";
import { baselineFillFacts } from "./fixtures/fill-facts.mjs";
import { parseRpcHttpRequestTimeoutMs } from "../../../shared/config/rpc-resilience.ts";
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
    isStaleResultCutRuntimeFailure,
    STALE_RESULT_GATE,
    STALE_RESULT_FINISH_FAILURE,
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
    livenessError,
    counterRetry,
    freshStatusCapture = true,
    releaseReason = STALE_RESULT_FINISH_FAILURE,
    requestTimeoutMs = parseRpcHttpRequestTimeoutMs({}),
    finishReadCount = 1,
    escapedStatus = false,
} = {}) {
    const world = createSimulationWorld({
        epochSeconds: 1_000_000,
        providers: { default: { branch: "A", head: 105 } },
        scripts: escapedStatus
            ? [
                  {
                      when: {
                          functionName:
                              escapedStatus === "aggregate"
                                  ? DEPLOYLESS_MULTICALL3.functionName
                                  : "getOrderStatus",
                      },
                      after: { barrier: "prearmed-status" },
                  },
              ]
            : [],
    });
    const { ledger } = world;
    let time = ledger.epochSeconds * 1000 + 10_000;
    let retryResult;
    const state = {
        ...baselineFillFacts(ledger, { branch: "A", head: 105 }),
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
    const aggregate = (functionName, args, number) =>
        createPublicClient({
            transport: custom({
                request: ({ method, params }) =>
                    world.handleRpc("default", {
                        jsonrpc: "2.0",
                        id: 4,
                        method,
                        params,
                    }),
            }),
        }).multicall({
            contracts: [
                {
                    address: ledger.addresses.seaport,
                    abi: CONTRACT_ABI,
                    functionName,
                    args,
                },
            ],
            blockNumber: BigInt(number),
            deployless: true,
            batchSize: 0,
            allowFailure: true,
        });
    const controller = createStaleResultCut({
        world,
        ledger,
        observe: () => structuredClone(state),
        assertAlive() {
            if (livenessError) throw livenessError;
        },
        now: () => time,
        requestTimeoutMs,
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
            if (freshStatusCapture)
                track(
                    call("getOrderStatus", [ledger.orders.bid.orderHash], 107),
                );
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
                    if (counterRetry === "scalar")
                        retryResult = decodeFunctionResult({
                            abi: CONTRACT_ABI,
                            functionName: "getCounter",
                            data: await call(
                                "getCounter",
                                [ledger.addresses.bidder],
                                105,
                            ),
                        });
                    if (counterRetry === "aggregate") {
                        const results = await aggregate(
                            "getCounter",
                            [ledger.addresses.bidder],
                            105,
                        );
                        retryResult = results[0].result;
                    }
                    for (
                        let index = 0;
                        finishRead && index < finishReadCount;
                        index++
                    )
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
                        state.makerRuns[0].last_error = releaseReason;
                        state.makerRuns[0].updated_at = time;
                    }
                    onOldReply?.(state, world);
                },
            ),
        );
    startOld();
    await world.waitForResponseGate(STALE_RESULT_GATE.OldCounter);
    if (escapedStatus) {
        track(
            escapedStatus === "aggregate"
                ? aggregate(
                      "getOrderStatus",
                      [ledger.orders.bid.orderHash],
                      105,
                  )
                : call("getOrderStatus", [ledger.orders.bid.orderHash], 105),
        );
        await world.waitForBarrier("prearmed-status");
    }
    const rollback = () => {
        world.switchBranch("B", { head: 107 });
        state.revision = 1;
        state.recovery = [
            {
                chain_id: ledger.chainId,
                recovery_id: "actual-retained-recovery",
                revision: 1,
                phase: REORG_RECOVERY_PHASE.Resync,
                checked_block: 104,
                stored_hash: ledger.blockAt("A", 104).hash,
                observed_hash: ledger.blockAt("B", 104).hash,
                range_from: 104,
                range_to: 105,
                target_block: 107,
            },
        ];
        state.coverage = Array.from({ length: 3 }, (_, i) => ({
            block_number: 101 + i,
        }));
        state.headers = state.coverage.map(({ block_number }) => ({
            block_number,
            block_hash: ledger.blockAt("B", block_number).hash,
            parent_hash: ledger.blockAt("B", block_number).parentHash,
        }));
        state.owners = ["1", "2"].map((token_id) => ({
            token_id,
            owner: ledger.addresses.seller,
            amount: "1",
        }));
        // Reviewed two-mint wire truth table, independent of product reducers.
        state.transfers = [101, 102].map((number) => {
            const block = ledger.blockAt("B", number);
            return {
                chain_id: ledger.chainId,
                collection_id: state.collectionId,
                contract_address: ledger.addresses.nft,
                from_address: ZERO_ADDRESS,
                to_address: ledger.addresses.seller,
                token_id: String(number - 100),
                amount: "1",
                block_number: number,
                block_hash: block.hash,
                block_timestamp: block.timestamp,
                tx_hash: block.logs[0].transactionHash,
                log_index: 0,
                kind: COLLECTION_STANDARD.Erc721,
            };
        });
        state.fillExecutions = [];
        state.fillItems = [];
        state.fillAttributions = [];
    };
    return {
        world,
        ledger,
        state,
        controller,
        rollback,
        startOld,
        retryResult: () => retryResult,
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

test("a retry returning B counter zero after A counter-one handoff cannot credit the old outcome", async () => {
    for (const counterRetry of ["scalar", "aggregate"]) {
        const f = await fixture({ counterRetry });
        try {
            await prepare(f);
            await assert.rejects(
                f.controller.releaseAndAssertRejected(),
                (error) => {
                    assert.equal(isStaleResultCutUnreached(error), true);
                    assert.equal(
                        error.simulation.staleResultCut.counterAttempts.length,
                        2,
                    );
                    const old =
                        error.simulation.staleResultCut.responseGates.find(
                            (entry) =>
                                entry.name === STALE_RESULT_GATE.OldCounter,
                        );
                    assert.equal(
                        old.captures.length,
                        1,
                        "The released gate cannot capture the later retry",
                    );
                    assert.equal(old.captures[0].delivered, true);
                    assert.equal(old.captures[0].matchingCalls[0].result, "1");
                    return true;
                },
            );
        } finally {
            await f.close();
        }
        assert.equal(f.retryResult(), 0n);
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

test("native actor death preserves the original liveness cause instead of becoming a missing-gate timeout", async () => {
    const cause = new Error("Native actor terminated");
    const failure = Object.assign(
        new Error(
            "Production domain exited (SIGSEGV); inspect its retained logs",
            { cause },
        ),
        { signal: "SIGSEGV" },
    );
    const f = await fixture({ livenessError: failure });
    try {
        await assert.rejects(f.controller.captureHeld(), (error) => {
            assert.equal(error, failure);
            assert.equal(error.cause, cause);
            assert.equal(error.signal, "SIGSEGV");
            assert.equal(error.property, PROPERTY.Runtime);
            assert.equal(isStaleResultCutUnreached(error), false);
            assert.equal(isStaleResultCutRuntimeFailure(error), true);
            assert.equal(error.simulation.staleResultCut.outcome, "unreached");
            return true;
        });
    } finally {
        await f.close();
    }
});

test("the committed rollback cut rejects orphan effects and requires its real retained recovery range", async () => {
    for (const corrupt of [
        (f) => {
            f.state.recovery = [];
        },
        (f) => {
            f.state.recovery[0].target_block = 106;
        },
        (f) => {
            f.state.headers[2].block_hash = f.ledger.blockAt("A", 105).hash;
        },
        (f) => {
            f.state.owners[0].owner = f.ledger.addresses.buyer;
        },
        (f) => {
            f.state.fillItems.push({ execution_id: "orphan-child" });
        },
    ]) {
        const f = await fixture();
        try {
            await f.controller.captureHeld();
            f.rollback();
            corrupt(f);
            await assert.rejects(
                f.controller.captureRollback(),
                isStaleResultCutUnreached,
            );
        } finally {
            await f.close();
        }
    }
});

test("active recovery may retain pending fresh demand without starting any new status RPC", async () => {
    const f = await fixture({ freshStatusCapture: false });
    try {
        await prepare(f);
        const result = await f.controller.releaseAndAssertRejected();
        assert.equal(result.baseline.proof.pending, 1);
        assert.equal(
            result.rollback.recovery.phase,
            REORG_RECOVERY_PHASE.Resync,
        );
        const fresh = result.responseGatesAtCut.find(
            (gate) => gate.name === STALE_RESULT_GATE.FreshStatus,
        );
        assert.deepEqual(fresh.captures, []);
        assert.deepEqual(result.freshStatusResponses, []);
        assert.equal(
            result.failedRelease.last_error,
            STALE_RESULT_FINISH_FAILURE,
        );
        assert.ok(result.timing.completedAt < result.timing.transportDeadline);
    } finally {
        await f.close();
    }
});

test("concurrent valid B acquisition does not require resync to finish before the cut", async () => {
    const f = await fixture();
    try {
        await f.controller.captureHeld();
        f.rollback();
        for (const number of [106, 107]) {
            const block = f.ledger.blockAt("B", number);
            f.state.coverage.push({ block_number: number });
            f.state.headers.push({
                block_number: number,
                block_hash: block.hash,
                parent_hash: block.parentHash,
            });
        }
        await f.controller.captureRollback();
        assert.equal(
            (await f.controller.releaseAndAssertRejected()).reached
                .durableFailedRelease,
            true,
        );
    } finally {
        await f.close();
    }
});

test("generic durable errors plus a completed B105 header cannot credit snapshot refusal", async () => {
    for (const releaseReason of [
        "Error: unrelated SQLite error",
        "Error: ABI decode failed",
        "OrderValidationSnapshotUnavailable: Validation snapshot lifetime exceeded",
    ]) {
        const f = await fixture({ releaseReason });
        try {
            await prepare(f);
            await assert.rejects(
                f.controller.releaseAndAssertRejected(),
                isStaleResultCutUnreached,
            );
            assert.equal(f.state.makerRuns[0].failures, 1);
            assert.ok(
                f.world.trace.some(
                    (entry) =>
                        entry.type === "response" &&
                        entry.method === "eth_getBlockByNumber",
                ),
            );
        } finally {
            await f.close();
        }
    }
});

test("the exact finish reason cannot credit a different maker or a replacement lease", async () => {
    for (const replacement of ["maker", "lease"]) {
        const f = await fixture({
            durableRelease: replacement !== "maker",
            onOldReply(state) {
                if (replacement === "maker")
                    state.makerRuns.push({
                        ...state.makerRuns[0],
                        run_id: "different-maker-run",
                        failures: 1,
                        lease_owner: null,
                        lease_until: 0,
                        last_error: STALE_RESULT_FINISH_FAILURE,
                    });
                else state.makerRuns[0].lease_version++;
            },
        });
        try {
            await prepare(f);
            await assert.rejects(
                f.controller.releaseAndAssertRejected(),
                isStaleResultCutUnreached,
            );
        } finally {
            await f.close();
        }
    }
});

test("a status response encoded before the global gate cannot escape unnoticed after arm", async () => {
    for (const escapedStatus of [true, "aggregate"]) {
        const f = await fixture({ escapedStatus });
        try {
            await f.controller.captureHeld();
            f.rollback();
            f.world.release("prearmed-status");
            await setImmediate();
            await assert.rejects(
                f.controller.captureRollback(),
                (error) =>
                    error.property === PROPERTY.Projection &&
                    !isStaleResultCutUnreached(error),
            );
        } finally {
            await f.close();
        }
    }
});

test("the original HTTP deadline is stricter than lease and snapshot lifetime", async () => {
    const f = await fixture({ requestTimeoutMs: 1500 });
    try {
        await f.controller.captureHeld();
        f.rollback();
        f.setTime(f.state.makerRuns[0].pass_started_at + 1501);
        await assert.rejects(
            f.controller.captureRollback(),
            isStaleResultCutUnreached,
        );
    } finally {
        await f.close();
    }
});

test("supporting B105 traffic may be concurrent when the original row has the exact finish refusal", async () => {
    const f = await fixture({ finishReadCount: 2 });
    try {
        await prepare(f);
        const result = await f.controller.releaseAndAssertRejected();
        assert.equal(
            result.failedRelease.last_error,
            STALE_RESULT_FINISH_FAILURE,
        );
        assert.equal(result.oldSnapshotHeaderCandidates.length, 2);
    } finally {
        await f.close();
    }
});

test("an exact refusal completed beyond the original transport deadline remains unproved", async () => {
    const f = await fixture({
        onOldReply(state) {
            f.setTime(
                state.makerRuns[0].pass_started_at +
                    parseRpcHttpRequestTimeoutMs({}) +
                    1,
            );
        },
    });
    try {
        await prepare(f);
        await assert.rejects(
            f.controller.releaseAndAssertRejected(),
            isStaleResultCutUnreached,
        );
        assert.equal(
            f.state.makerRuns[0].last_error,
            STALE_RESULT_FINISH_FAILURE,
        );
    } finally {
        await f.close();
    }
});

test("typed ordinary actor exits retain the lifecycle property through the stale cut", async () => {
    const failure = new RuntimeProcessExit({
        actorId: "domain",
        pid: 156,
        signal: "SIGSEGV",
    });
    const wrapper = new Error("Observed actor exit", { cause: failure });
    const f = await fixture({ livenessError: wrapper });
    try {
        await assert.rejects(f.controller.captureHeld(), (error) => {
            assert.equal(error, wrapper);
            assert.equal(findRuntimeProcessExit(error), failure);
            assert.equal(failure.property, RUNTIME_PROCESS_PROPERTY.Liveness);
            assert.equal(error.cause, failure);
            assert.equal(error.property, RUNTIME_PROCESS_PROPERTY.Liveness);
            assert.equal(isStaleResultCutRuntimeFailure(error), true);
            assert.equal(error.simulation.staleResultCut.outcome, "unreached");
            return true;
        });
    } finally {
        await f.close();
    }
});
