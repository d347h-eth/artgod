import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_PROCESS } from "./runtime-manifest.mjs";
import { launchRuntime } from "./runtime-process.mjs";
import {
    createHeadProgress,
    publishedBusinessWorkDrained,
} from "./head-progress.mjs";
import {
    executeSplitProviderFork,
    beginSplitProviderRecovery,
    SPLIT_PROVIDER_EVENT,
} from "./split-provider-fork.mjs";
import {
    createStaleResultCut,
    STALE_RESULT_PROPERTY,
} from "./stale-result-cut.mjs";
import { recordDataPlaneFailureChecks } from "./data-plane-failure.mjs";
import {
    captureGuestNativeFailure,
    prepareNativeDiagnostics,
    NATIVE_FAILURE_ARTIFACT,
} from "./native-failure-evidence.mjs";
import { assertCanonicalFillFacts } from "./fill-oracle.mjs";
import { ORDER_SEAPORT_DATA_SOURCE_KIND } from "../../../indexer/src/domain/orders.ts";
import {
    PROVIDER_DISAGREEMENT_PHASE as DISAGREEMENT_PHASE,
    PROVIDER_DISAGREEMENT_PROPERTY as DISAGREEMENT_PROPERTY,
    completedDisagreementRead,
    healDisagreementProviders,
    assertFreshValidatorProof,
} from "./provider-disagreement.mjs";
import { db, setDbPath } from "../../../shared/database/db.ts";
import { MigrationRunner } from "../../../shared/database/migrations.ts";
import {
    COLLECTION_STANDARD,
    COLLECTION_STATUS,
    OPENSEA_COLLECTION_STATUS,
} from "../../../shared/types/browse.ts";
import { ACTIVITY_KIND } from "../../../shared/types/activity-feed.ts";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
} from "../../../shared/market-data/orders.ts";
import { resolveNatsJobStreamName } from "../../../shared/queue/nats-job-stream.ts";
import { startWorldServer } from "../world/server.mjs";
import { QUEUE_OUTBOX_STATUS } from "../../../indexer/src/domain/queue-outbox.ts";
import { MAKER_REVALIDATION_STATUS } from "../../../indexer/src/domain/maker-revalidation.ts";
import { ORDER_VALIDATION_BATCH_POLICY } from "../../../indexer/src/domain/order-validation-policy.ts";
import { parseRpcHttpRequestTimeoutMs } from "../../../shared/config/rpc-resilience.ts";
import {
    DATA_PLANE_JOURNEY,
    EXTERNAL_ACTION,
    DEFAULT_FORK_SCHEDULE,
    RUNTIME_PROFILE,
    VALIDATION_RELEASE,
} from "./scenario-contract.mjs";
import { OFFCHAIN_OBSERVATION_CHANNEL } from "../../../indexer/src/domain/offchain-jobs.ts";
import {
    assertCanonicalAcquisition,
    assertMarketConvergence,
} from "./oracle.mjs";
import { executeProcessFault } from "./process-faults.mjs";
import { executeStartupMaintenance } from "./lifecycle.mjs";
import { declareTradingIntent } from "./operator-inputs.mjs";
import { DATA_PLANE_CHECK as CHECK } from "../qualification-protocol.mjs";
import { observeRetainedRawInput } from "./queue-observation.mjs";
import { verifyRefusedProof } from "./refused-proof.mjs";
import { executeCollectionBootstrap } from "./bootstrap-journey.mjs";
import {
    assertPassiveBidBook,
    PASSIVE_BID_BOOK_STAGE,
} from "./passive-bid-book.mjs";

const SIMULATION_STREAM_PREFIX = "simulation";

/** Explicit synthetic launch inputs; never inherit operator service targets. */
export function runtimeFixtureEnvironment({
    root,
    databasePath,
    rpcUrl,
    rpcEndpoints,
    natsUrl,
    addresses,
    runtimeProfile = RUNTIME_PROFILE.Unrestricted,
}) {
    const environment = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        ARTGOD_WORKSPACE_ROOT: root,
        ARTGOD_ENV_FILE: path.join(root, "state/runtime.env"),
        ARTGOD_DB_PATH: databasePath,
        COMMON_MEDIA_CACHE_DIR: path.join(root, "state/media"),
        TMPDIR: path.join(root, "state/tmp"),
        NODE_EXTRA_CA_CERTS: path.join(root, "certs/ca.pem"),
        NATS_URL: natsUrl,
        NATS_STREAM_PREFIX: SIMULATION_STREAM_PREFIX,
        CHAIN_ID: "1",
        RPC_URL_LIST: JSON.stringify(
            rpcEndpoints ?? [{ url: rpcUrl, weight: 1 }],
        ),
        REORG_DEPTH: "3",
        BACKFILL_BATCH_SIZE: "2",
        BACKFILL_WORKER_COUNT: "1",
        RPC_RATE_LIMIT_MODE: "unlimited",
        GAP_FILL_MODE: "unlimited",
        WETH_ADDRESS: addresses.weth,
        SEAPORT_CONDUIT_CONTROLLER: addresses.conduitController,
        OPENSEA_INTEGRATION_MODE: "enabled",
        OPENSEA_API_KEY: "synthetic-simulation-key",
        OFFCHAIN_PERSIST_RAW_OBSERVATIONS: "true",
        OPENSEA_RECONCILE_INTERVAL_MS: "1000",
        OPENSEA_STALE_START_THRESHOLD_MS: "1000",
        OPENSEA_STREAM_SUBSCRIPTION_POLL_MS: "1000",
        INDEXER_APM_ENABLED: "false",
        INDEXER_METRICS_ENABLED: "false",
        BACKEND_APM_ENABLED: "false",
        BACKEND_METRICS_ENABLED: "false",
        BACKEND_HOST: "127.0.0.1",
        BACKEND_PORT: "42722",
        BACKEND_ALLOWED_HOSTS: "127.0.0.1,localhost",
        BACKEND_ALLOWED_ORIGINS: "http://127.0.0.1:42722",
        BACKEND_QUERY_CACHE_PROVIDER: "disabled",
    };
    if (runtimeProfile === RUNTIME_PROFILE.Default) {
        // Let the owning production typed config read its current defaults.
        delete environment.RPC_RATE_LIMIT_MODE;
        delete environment.GAP_FILL_MODE;
    }
    return environment;
}

function serializeEnv(env) {
    return (
        Object.entries(env)
            .map(([key, value]) => {
                assert.ok(
                    !/[\r\n']/.test(value),
                    `Fixture env value cannot contain newlines or single quotes: ${key}`,
                );
                return `${key}='${value}'`;
            })
            .join("\n") + "\n"
    );
}

/** Inspect operator declarations without including independently changing projections. */
function observeDeclarations(database, collectionId) {
    return database
        .transaction(() => ({
            collections: database
                .prepare(
                    "SELECT collection_id,chain_id,slug,address,standard,status,token_scope_kind,scope_start_token_id,scope_total_supply,deployment_block,opensea_slug FROM collections WHERE collection_id=?",
                )
                .all(collectionId),
            tradingJobs: database
                .prepare(
                    "SELECT j.job_id,j.bot_kind,j.chain_id,j.collection_id,j.status,j.target_kind,j.token_id,j.revision,j.archived_at,s.floor_wei,s.ceiling_wei,s.delta_wei,s.quantity,s.target_traits_json,s.competitor_traits_json,s.price_tier_id,s.pricing_source_json,s.competition_preset_version_id FROM trading_jobs j JOIN trading_bidding_job_specs s ON s.job_id=j.job_id WHERE j.collection_id=? ORDER BY j.job_id",
                )
                .all(collectionId),
            priceTiers: database
                .prepare(
                    "SELECT tier_id,chain_id,collection_id,name,status,sort_order,parent_tier_id,floor_config_json,ceiling_config_json,delta_wei,archived_at,revision FROM trading_bidding_price_tiers WHERE collection_id=? ORDER BY tier_id",
                )
                .all(collectionId),
            tradingCommands: database
                .prepare(
                    "SELECT c.command_id,c.job_id,c.bot_kind,c.command_kind,c.status,c.requested_revision,c.payload_json FROM trading_job_commands c JOIN trading_jobs j ON j.job_id=c.job_id WHERE j.collection_id=? ORDER BY c.command_id",
                )
                .all(collectionId),
        }))
        .deferred();
}

/** Execute unchanged production maintenance CLIs with retained, bounded output. */
async function runOneShot(spec, { root, output, env, stopProcess }) {
    const stdoutPath = path.join(output, `${spec.id}.stdout.log`);
    const stderrPath = path.join(output, `${spec.id}.stderr.log`);
    const stdout = await open(stdoutPath, "wx");
    const stderr = await open(stderrPath, "wx");
    let timedOut = false;
    let outputLimit = false;
    let bytes = 0;
    let failure;
    const writes = [];
    const child = spawn(process.execPath, [spec.filename], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const completion = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
    }, 120_000);
    const retain = (file) => (chunk) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
            outputLimit = true;
            child.kill("SIGKILL");
            return;
        }
        writes.push(
            file.write(chunk).catch((error) => {
                failure = error;
            }),
        );
    };
    child.stdout.on("data", retain(stdout));
    child.stderr.on("data", retain(stderr));
    try {
        const result = await completion;
        await Promise.all(writes);
        if (failure) throw failure;
        return {
            artifact: spec.artifact,
            filename: spec.filename,
            ...result,
            timedOut,
            outputLimit,
            stdoutPath,
            stderrPath,
        };
    } finally {
        clearTimeout(timeout);
        await stopProcess(child, "SIGKILL");
        await stdout.close();
        await stderr.close();
    }
}

function observe(database, collectionId) {
    return database
        .transaction(() => {
            const makerRuns = database
                .prepare(
                    "SELECT run_id,chain_id,source_job_id,payload_json,status,after_id,upper_order_id,upper_rowid,lease_owner,lease_version,lease_until,step,resolved_orders,deferred_orders,generation,pass_generation,pass_started_at,failures,last_error,created_at,updated_at FROM maker_order_revalidation_runs WHERE chain_id=1 AND status<>? ORDER BY run_id",
                )
                .all(MAKER_REVALIDATION_STATUS.Completed);
            return {
                makerRuns,
                collectionId,
                fillExecutions: database
                    .prepare(
                        "SELECT id,chain_id,kind,protocol_address,tx_hash,log_index,block_number,block_hash,block_timestamp,price_exclusion,total_price,currency,nft_quantity FROM fill_executions WHERE chain_id=1 ORDER BY id",
                    )
                    .all(),
                // Do not join through parents: orphan items are part of the oracle.
                fillItems: database
                    .prepare(
                        "SELECT execution_id,item_index,side,item_type,contract_address,identifier,amount,recipient,unit_offset FROM fill_execution_items ORDER BY execution_id,item_index",
                    )
                    .all(),
                fillAttributions: database
                    .prepare(
                        "SELECT chain_id,collection_id,execution_id,item_index,kind,order_id,order_side,maker,taker,contract_address,token_id,amount,block_number,block_hash,block_timestamp,tx_hash,log_index FROM fills WHERE chain_id=1 ORDER BY execution_id,item_index,collection_id",
                    )
                    .all(),
                owners: database
                    .prepare(
                        "SELECT token_id,owner,amount,last_block_number FROM nft_balances WHERE chain_id=1 AND collection_id=? ORDER BY token_id,owner",
                    )
                    .all(collectionId),
                orders: database
                    .prepare(
                        "SELECT id,side,fillability_status,source_status,validated_at,state_revision,seaport_data_source_kind FROM orders WHERE chain_id=1 AND collection_id=? ORDER BY id",
                    )
                    .all(collectionId),
                transfers: database
                    .prepare(
                        "SELECT chain_id,collection_id,contract_address,from_address,to_address,token_id,amount,block_number,block_hash,block_timestamp,tx_hash,log_index,kind FROM nft_transfer_events WHERE chain_id=1 AND collection_id=? ORDER BY block_number,log_index,token_id",
                    )
                    .all(collectionId),
                activities: database
                    .prepare(
                        "SELECT kind,block_number,token_id,order_id FROM activities WHERE chain_id=1 AND collection_id=? ORDER BY id",
                    )
                    .all(collectionId),
                coverage: database
                    .prepare(
                        "SELECT block_number FROM collection_sync_blocks WHERE chain_id=1 AND collection_id=? ORDER BY block_number",
                    )
                    .all(collectionId),
                headers: database
                    .prepare(
                        "SELECT block_number,block_hash,parent_hash FROM blocks WHERE chain_id=1 ORDER BY block_number",
                    )
                    .all(),
                revision:
                    database
                        .prepare(
                            "SELECT revision FROM chain_sync_revisions WHERE chain_id=1",
                        )
                        .get()?.revision ?? 0,
                recovery: database
                    .prepare(
                        "SELECT * FROM chain_reorg_recoveries WHERE chain_id=1",
                    )
                    .all(),
                pendingDemand: database
                    .prepare(
                        "SELECT order_id,next_attempt_at,lease_until,last_error FROM order_validation_demand WHERE chain_id=1 AND pending=1 ORDER BY order_id",
                    )
                    .all(),
                validationProofs: database
                    .prepare(
                        "SELECT order_id,generation,pending,required_at,minimum_block,proof_revision,proof_at,proof_block,proof_chain_revision FROM order_validation_demand WHERE chain_id=1 ORDER BY order_id",
                    )
                    .all(),
                pendingOutbox: database
                    .prepare(
                        "SELECT outbox_id,status FROM queue_outbox WHERE status<>? ORDER BY outbox_id LIMIT 100",
                    )
                    .all(QUEUE_OUTBOX_STATUS.Sent),
                unfinishedMaker: makerRuns,
                canonicalChecks: database
                    .prepare(
                        "SELECT block_number,block_hash FROM blocks WHERE chain_id=1 AND canonical_check_pending=1 ORDER BY block_number",
                    )
                    .all(),
                observations: database
                    .prepare(
                        "SELECT channel,event_type,order_id,source_event_at FROM offchain_order_observations WHERE chain_id=1 AND collection_id=? ORDER BY observation_id",
                    )
                    .all(collectionId),
            };
        })
        .deferred();
}

async function fetchJson(url) {
    const response = await fetch(url);
    assert.equal(
        response.status,
        200,
        `${url}: ${await response.clone().text()}`,
    );
    return response.json();
}

async function bounded(promise, label, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(label)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function scheduleEvidence(world) {
    return {
        externalActions: world.trace.filter(
            (entry) => entry.type === "scenario-action",
        ),
        reachedBarriers: [
            ...new Set(
                world.trace
                    .filter((entry) => entry.type === "barrier-reached")
                    .map((entry) => entry.name),
            ),
        ],
    };
}

/** Real runtime entrypoints; only the outside chain/marketplace wire is simulated. */
export async function runDataPlane(
    scenario,
    {
        root,
        layout,
        state,
        output,
        eventually,
        startBroker,
        stopBroker,
        stopProcess,
    },
) {
    await mkdir(state, { recursive: true });
    await mkdir(path.join(state, "tmp"), { recursive: true });
    await mkdir(output, { recursive: true });
    const databasePath = path.join(state, "artgod.sqlite");
    const server = await startWorldServer({
        host: "127.0.0.1",
        port: 443,
        urlHostname: "api.opensea.io",
        tls: {
            key: await readFile(path.join(root, "certs/server.key")),
            cert: await readFile(path.join(root, "certs/server.pem")),
        },
        scenario: {
            epochSeconds: Math.floor(Date.now() / 1000),
            ...scenario.world,
        },
    });
    const { ledger } = server.world;
    const bootstrapJourney =
        scenario.journey === DATA_PLANE_JOURNEY.CollectionBootstrap;
    // The bootstrap fixture snapshots through the actual depth3 anchor, while
    // ordinary scenarios deliberately start with an already-live anchor100.
    const acquisitionLedger = bootstrapJourney
        ? { ...ledger, anchorBlock: 102 }
        : ledger;
    const processes = [];
    let broker;
    let observer;
    let collectionId;
    let headProgress;
    let staleResultCut;
    let nativeDiagnostics;
    const checkpoints = [];
    const checks = {};
    const expectedSourceStatuses = {};
    let providerDisagreementReached = false;
    let activeCheck = CHECK.RuntimeEntrypoints;
    try {
        if (scenario.nativeDiagnostics)
            nativeDiagnostics = await prepareNativeDiagnostics({
                settings: scenario.nativeDiagnostics,
                root,
                output,
            });
        if (scenario.headProgress)
            headProgress = createHeadProgress({
                world: server.world,
                ledger,
                maximumHead: scenario.headProgress.maximumHead,
                providers: Object.keys(server.rpcUrls),
            });
        checks[activeCheck] = false;
        // Setup creates declared collection identity/anchor only. Ownership, token
        // metadata, order outcomes, facts and recovery revisions come from runtime work.
        setDbPath(databasePath);
        await new MigrationRunner(
            path.join(root, "database/migrations"),
        ).runMigrations();
        if (!bootstrapJourney) {
            const inserted = db
                .prepare(
                    "INSERT INTO collections(chain_id,slug,address,standard,status,token_scope_kind,bootstrap_anchor_block,bootstrap_last_synced_block,opensea_slug,opensea_status) VALUES(?,?,?,?,?,'contract_all_tokens',?,?,?,?)",
                )
                .run(
                    ledger.chainId,
                    ledger.collectionSlug,
                    ledger.addresses.nft,
                    COLLECTION_STANDARD.Erc721,
                    COLLECTION_STATUS.Live,
                    ledger.anchorBlock,
                    ledger.anchorBlock,
                    ledger.collectionSlug,
                    OPENSEA_COLLECTION_STATUS.Ready,
                );
            collectionId = Number(inserted.lastInsertRowid);
        }
        db.raw.close();
        const Database = createRequire(layout.sqliteIssuer)("better-sqlite3");
        observer = new Database(databasePath, {
            readonly: true,
            fileMustExist: true,
        });
        observer.pragma("busy_timeout = 5000");
        broker = await startBroker();
        const env = runtimeFixtureEnvironment({
            root,
            databasePath,
            rpcUrl: server.rpcUrl,
            rpcEndpoints: (scenario.rpcProviders ?? ["default"]).map(
                (provider) => {
                    assert.ok(
                        server.rpcUrls[provider],
                        `Unknown simulated RPC provider ${provider}`,
                    );
                    return { url: server.rpcUrls[provider], weight: 1 };
                },
            ),
            natsUrl: broker.url,
            addresses: ledger.addresses,
            runtimeProfile: scenario.runtimeProfile,
        });
        await writeFile(env.ARTGOD_ENV_FILE, serializeEnv(env));
        for (const spec of [
            ...layout.processes,
            ...(bootstrapJourney ? layout.bootstrapProcesses : []),
        ])
            processes.push(
                await launchRuntime(spec, {
                    root,
                    output,
                    env,
                    eventually,
                    nativeDiagnostics,
                }),
            );
        checks[CHECK.RuntimeEntrypoints] = true;
        const alive = () => {
            headProgress?.assertHealthy();
            for (const process of processes)
                if (!process.intentionallyStopped) process.assertAlive();
        };
        const snapshot = () => {
            alive();
            return observe(observer, collectionId);
        };
        const observeBootstrap = ({ runId, collectionId: id }) => {
            alive();
            return observer
                .transaction(() => ({
                    owners: observer
                        .prepare(
                            "SELECT token_id,owner,amount,last_block_number FROM nft_balances WHERE chain_id=1 AND collection_id=? ORDER BY token_id,owner",
                        )
                        .all(id),
                    metadata: observer
                        .prepare(
                            "SELECT token_id,name FROM token_metadata WHERE chain_id=1 AND collection_id=? ORDER BY token_id",
                        )
                        .all(id),
                    coverage: observer
                        .prepare(
                            "SELECT block_number FROM collection_sync_blocks WHERE chain_id=1 AND collection_id=? ORDER BY block_number",
                        )
                        .all(id),
                    events: observer
                        .prepare(
                            "SELECT event_code,payload_json FROM bootstrap_run_events WHERE run_id=? ORDER BY id",
                        )
                        .all(runId),
                    steps: observer
                        .prepare(
                            "SELECT step_key,status FROM bootstrap_run_steps WHERE run_id=? ORDER BY step_key",
                        )
                        .all(runId),
                    run: observer
                        .prepare(
                            "SELECT status FROM bootstrap_runs WHERE run_id=?",
                        )
                        .get(runId),
                }))
                .deferred();
        };
        const closeSources = async (
            ids = [
                RUNTIME_PROCESS.OpenSeaStream,
                RUNTIME_PROCESS.OpenSeaReconcileScheduler,
                RUNTIME_PROCESS.OpenSeaBootstrap,
            ],
        ) => {
            for (const entry of processes.filter((item) =>
                ids.includes(item.id),
            )) {
                if (entry.intentionallyStopped) continue;
                entry.intentionallyStopped = true;
                await stopProcess(entry.child);
            }
        };
        const faultContext = {
            processes,
            broker,
            stopProcess,
            eventually,
            closeSources,
            observe: snapshot,
            startupMaintenance: layout.startupMaintenance,
            observeDeclarations: () =>
                observeDeclarations(observer, collectionId),
            runOneShot: (spec) =>
                runOneShot(spec, { root, output, env, stopProcess }),
            async restartProcess(id) {
                const index = processes.findIndex((entry) => entry.id === id);
                assert.ok(
                    index >= 0,
                    "A known actual runtime process must be restarted",
                );
                const original = processes[index];
                original.intentionallyStopped = true;
                await stopProcess(original.child, "SIGKILL");
                const replacement = await launchRuntime(
                    {
                        ...original,
                        intentionallyStopped: false,
                        generation: (original.generation ?? 0) + 1,
                    },
                    { root, output, env, eventually },
                );
                processes[index] = replacement;
                return replacement;
            },
            async restartBroker() {
                await stopBroker(broker);
                broker = await startBroker();
                return broker;
            },
            async emitExternalInput() {
                const orderId = ledger.orders.bid.orderHash;
                const previous = snapshot()
                    .observations.filter((entry) => entry.order_id === orderId)
                    .map((entry) => entry.source_event_at ?? 0);
                const latest = Math.max(0, ...previous);
                await eventually(
                    () => Math.floor(Date.now() / 1000) > latest,
                    "a real current source timestamp newer than prior audit input",
                    10_000,
                );
                const sourceEventAt = Math.floor(Date.now() / 1000);
                // Cancellation is a coherent external marketplace transition.
                // REST/stream skew needs its own authored fault history.
                server.world.setMarket({
                    offers: server.world.market.offers.filter(
                        (order) => order.order_hash !== orderId,
                    ),
                });
                const deliveredRecipients = server.pushStreamEvent(
                    server.world.cancellationEventFor("bid", {
                        observedAt: sourceEventAt,
                    }),
                );
                assert.ok(
                    deliveredRecipients > 0,
                    "Fault input must reach a real OpenSea stream subscriber",
                );
                expectedSourceStatuses[orderId] = ORDER_SOURCE_STATUS.Cancelled;
                return {
                    orderId,
                    sourceEventAt,
                    deliveredRecipients,
                    expectedSourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                };
            },
            queueState(input) {
                return observeRetainedRawInput(
                    broker.connection,
                    env.NATS_STREAM_PREFIX,
                    input,
                );
            },
        };
        if (bootstrapJourney) {
            activeCheck = CHECK.CollectionBootstrap;
            checks[activeCheck] = false;
            const bootstrap = await executeCollectionBootstrap({
                origin: "http://127.0.0.1:42722",
                chainRef: "ethereum",
                world: server.world,
                processes,
                restartProcess: faultContext.restartProcess,
                stopProcess,
                eventually,
                observeBootstrap,
                onCreated: ({ collectionId: id }) => {
                    collectionId = id;
                },
                onAnchored: () => headProgress?.start(),
            });
            checks[activeCheck] = true;
            checkpoints.push({ name: CHECK.CollectionBootstrap, bootstrap });
        }
        activeCheck = CHECK.ChainAcquisition;
        checks[activeCheck] = false;
        await eventually(
            () => {
                const current = snapshot();
                return (
                    current.owners.length === 2 &&
                    (bootstrapJourney ||
                        current.transfers.filter(
                            (row) => row.block_number <= ledger.initialHead,
                        ).length === 2)
                );
            },
            bootstrapJourney
                ? "actual anchored bootstrap ownership"
                : "actual initial mint acquisition",
            120_000,
        );
        const initial = snapshot();
        assert.deepEqual(
            initial.owners.map((row) => [row.token_id, row.owner, row.amount]),
            [
                ["1", ledger.addresses.seller, "1"],
                ["2", ledger.addresses.seller, "1"],
            ],
        );
        checks[CHECK.ChainAcquisition] = true;
        activeCheck = CHECK.OrderValidation;
        checks[activeCheck] = false;
        await eventually(
            () => {
                const orders = snapshot().orders;
                return (
                    orders.length === 2 &&
                    orders.every(
                        (order) =>
                            order.validated_at > 0 &&
                            order.fillability_status === ORDER_STATUS.Fillable,
                    )
                );
            },
            "actual source admission and full order validation",
            120_000,
        );
        assert.ok(
            server.world.trace.some(
                (entry) =>
                    entry.type === "request" && entry.method === "eth_call",
            ),
            "The real validator must issue wire reads",
        );
        checks[CHECK.OrderValidation] = true;
        activeCheck = CHECK.SourceIngestion;
        checks[activeCheck] = false;
        await eventually(
            () => server.subscriptionCount() > 0,
            "actual OpenSea stream subscription",
            60_000,
        );
        // Keep the disagreement listing REST-owned until its later genuine
        // first stream observation creates a new canonical source revision.
        const initialStreamOrder =
            scenario.journey === DATA_PLANE_JOURNEY.ProviderDisagreement
                ? "bid"
                : "listing";
        server.pushStreamEvent(server.world.streamEventFor(initialStreamOrder));
        await eventually(
            () =>
                snapshot().observations.some(
                    (entry) =>
                        entry.channel === OFFCHAIN_OBSERVATION_CHANNEL.Stream &&
                        entry.order_id ===
                            ledger.orders[initialStreamOrder].orderHash,
                ),
            "actual stream payload admission",
            60_000,
        );
        checks[CHECK.SourceIngestion] = true;
        const api = `http://127.0.0.1:42722/api/ethereum/${ledger.collectionSlug}`;
        activeCheck = CHECK.HttpProjection;
        checks[activeCheck] = false;
        const initialHttp = await fetchJson(api);
        assert.ok(
            initialHttp.tokens.items.some(
                (token) =>
                    token.tokenId === "1" &&
                    token.listingPrice ===
                        ledger.orders.listing.raw.price.current.value.toString(),
            ),
            "HTTP current asks must expose the simulated listing",
        );
        checkpoints.push({
            name: "initial",
            state: snapshot(),
            http: initialHttp,
        });
        if (
            headProgress &&
            ![
                DATA_PLANE_JOURNEY.Fork,
                DATA_PLANE_JOURNEY.CollectionBootstrap,
            ].includes(scenario.journey)
        )
            headProgress.start();
        if (scenario.journey === DATA_PLANE_JOURNEY.RefusedProof) {
            activeCheck = CHECK.SafeRefusal;
            checks[activeCheck] = false;
            const refusal = await verifyRefusedProof({
                world: server.world,
                ledger,
                observe: snapshot,
                eventually,
                closeSources,
                reorgDepth: Number(env.REORG_DEPTH),
            });
            checks[activeCheck] = true;
            checkpoints.push({ name: CHECK.SafeRefusal, ...refusal });
            return {
                checks,
                evidence: {
                    processes: processes.map((entry) => ({
                        id: entry.id,
                        artifact: entry.artifact,
                    })),
                    checkpoints,
                    world: server.world.snapshot(),
                    runtimeProfile:
                        scenario.runtimeProfile ?? RUNTIME_PROFILE.Unrestricted,
                    ...scheduleEvidence(server.world),
                },
            };
        }
        if (scenario.journey === DATA_PLANE_JOURNEY.ProcessRecovery) {
            activeCheck = CHECK.ProcessRecovery;
            checks[activeCheck] = false;
            const evidence = await executeProcessFault(
                scenario.processFault,
                faultContext,
            );
            checks[activeCheck] = true;
            checkpoints.push({
                name: CHECK.ProcessRecovery,
                processFault: evidence,
            });
        }
        if (scenario.journey === DATA_PLANE_JOURNEY.StartupMaintenance) {
            activeCheck = CHECK.StartupMaintenance;
            checks[activeCheck] = false;
            const operatorIntent = await declareTradingIntent({
                origin: "http://127.0.0.1:42722",
                chainRef: "ethereum",
                collectionRef: ledger.collectionSlug,
                tokenRef: "1",
            });
            const passiveReadContext = {
                origin: "http://127.0.0.1:42722",
                chainRef: "ethereum",
                collectionRef: ledger.collectionSlug,
                ledger,
                expectedJobId: operatorIntent.jobId,
            };
            const passiveBefore = await assertPassiveBidBook({
                ...passiveReadContext,
                expectedBidVisible: true,
            });
            checkpoints.push({
                name: PASSIVE_BID_BOOK_STAGE.Before,
                passiveBidBook: passiveBefore,
            });
            const evidence = await executeStartupMaintenance(faultContext);
            const passiveAfter = await assertPassiveBidBook({
                ...passiveReadContext,
                expectedBidVisible: false,
            });
            checkpoints.push({
                name: PASSIVE_BID_BOOK_STAGE.After,
                passiveBidBook: passiveAfter,
            });
            checks[activeCheck] = true;
            checkpoints.push({
                name: CHECK.StartupMaintenance,
                operatorIntent,
                lifecycle: evidence,
                passiveBidBook: { before: passiveBefore, after: passiveAfter },
            });
        }

        if (scenario.journey === DATA_PLANE_JOURNEY.Fork) {
            activeCheck = CHECK.ReorgRecovery;
            checks[activeCheck] = false;
            if (scenario.staleResultCut) {
                // Periodic REST input must finish before the captured attempt.
                // Keep the real stream subscriber idle for the later S action.
                await closeSources([
                    RUNTIME_PROCESS.OpenSeaReconcileScheduler,
                    RUNTIME_PROCESS.OpenSeaBootstrap,
                ]);
                const manager = await broker.connection.jetstreamManager();
                await eventually(
                    async () => {
                        const current = snapshot();
                        const stream = await manager.streams.info(
                            resolveNatsJobStreamName(env.NATS_STREAM_PREFIX),
                        );
                        return (
                            current.pendingDemand.length === 0 &&
                            current.pendingOutbox.length === 0 &&
                            current.unfinishedMaker.length === 0 &&
                            current.recovery.length === 0 &&
                            stream.state.messages === 0
                        );
                    },
                    "retained REST prefix settles before the stale-result cut",
                    120_000,
                );
                checkpoints.push({
                    name: "stale-result-quiet-prefix",
                    state: snapshot(),
                });
            }
            server.world.setPhase("sale");
            server.world.market.listings = [];
            server.world.advanceHead(104);
            await eventually(
                () => {
                    const current = snapshot();
                    return (
                        current.owners.some(
                            (row) =>
                                row.token_id === "1" &&
                                row.owner === ledger.addresses.buyer,
                        ) &&
                        current.activities.some(
                            (row) =>
                                row.kind === ACTIVITY_KIND.Sale &&
                                row.block_number === 104,
                        ) &&
                        current.orders.some(
                            (row) =>
                                row.id === ledger.orders.listing.orderHash &&
                                row.fillability_status === ORDER_STATUS.Filled,
                        )
                    );
                },
                "actual branch A fill/ownership/history",
                120_000,
            );
            let saleHttp;
            await eventually(
                async () => {
                    saleHttp = await fetchJson(api);
                    return !saleHttp.tokens.items.some(
                        (token) => token.tokenId === "1" && token.listingPrice,
                    );
                },
                "A processed fill removes the current ask through actual HTTP",
                60_000,
            );
            const saleActivity = await fetchJson(`${api}/1/activity`);
            assert.equal(
                saleActivity.token.currentHolder,
                ledger.addresses.buyer,
            );
            assert.ok(
                saleActivity.activities.items.some(
                    (activity) => activity.kind === ACTIVITY_KIND.Sale,
                ),
            );
            assertCanonicalFillFacts({
                snapshot: snapshot(),
                ledger,
                branch: "A",
                head: 104,
            });
            checkpoints.push({
                name: "branch-a-sale",
                state: snapshot(),
                http: saleHttp,
                activity: saleActivity,
            });
            if (scenario.staleResultCut)
                staleResultCut = createStaleResultCut({
                    world: server.world,
                    ledger,
                    observe: snapshot,
                    eventually,
                    assertAlive: alive,
                    requestTimeoutMs: parseRpcHttpRequestTimeoutMs(env),
                    async admitFreshBidRequirement({
                        before,
                        orderId,
                        assertLive,
                    }) {
                        const previous = before.orders.find(
                            (order) => order.id === orderId,
                        );
                        const previousProof = before.validationProofs.find(
                            (proof) => proof.order_id === orderId,
                        );
                        assert.equal(
                            previous?.seaport_data_source_kind,
                            ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
                            "The guarded bid must still be owned by its real REST prefix",
                        );
                        const priorSourceEventAt = Math.max(
                            0,
                            ...before.observations
                                .filter((entry) => entry.order_id === orderId)
                                .map((entry) => entry.source_event_at ?? 0),
                        );
                        await eventually(
                            () => {
                                assertLive();
                                return (
                                    Math.floor(Date.now() / 1000) >
                                    priorSourceEventAt
                                );
                            },
                            "a current bid stream timestamp newer than its retained audit input",
                            ORDER_VALIDATION_BATCH_POLICY.snapshotLifetimeMs,
                        );
                        const sourceEventAt = Math.floor(Date.now() / 1000);
                        const deliveredRecipients = server.pushStreamEvent(
                            server.world.streamEventFor("bid", {
                                observedAt: sourceEventAt,
                            }),
                        );
                        assert.ok(
                            deliveredRecipients > 0,
                            "The fresh bid requirement must reach the actual stream subscriber",
                        );
                        await eventually(
                            () => {
                                assertLive();
                                const current = snapshot();
                                const order = current.orders.find(
                                    (row) => row.id === orderId,
                                );
                                const proof = current.validationProofs.find(
                                    (row) => row.order_id === orderId,
                                );
                                return (
                                    order?.state_revision >
                                        previous.state_revision &&
                                    order.seaport_data_source_kind ===
                                        ORDER_SEAPORT_DATA_SOURCE_KIND.Stream &&
                                    proof?.generation >
                                        (previousProof?.generation ?? 0) &&
                                    proof.pending === 1
                                );
                            },
                            "the first real bid stream input admits a newer retained source requirement",
                            ORDER_VALIDATION_BATCH_POLICY.snapshotLifetimeMs,
                        );
                        return {
                            sourceEventAt,
                            priorSourceEventAt,
                            deliveredRecipients,
                        };
                    },
                });
            server.world.setPhase("fork-held");
            server.world.advanceHead(105);
            if (staleResultCut) {
                activeCheck = CHECK.StaleResultSafetyCut;
                checkpoints.push({
                    name: STALE_RESULT_PROPERTY.Held,
                    staleResultCut: await staleResultCut.captureHeld(),
                });
            } else {
                let validationHeld = false;
                void server.world.waitForBarrier("old-validation").then(() => {
                    validationHeld = true;
                });
                await eventually(
                    () => {
                        alive();
                        return validationHeld;
                    },
                    "No actual validation reached the requested external response barrier",
                    120_000,
                );
            }
            if (scenario.splitProviderFork) {
                const split = await executeSplitProviderFork(
                    scenario.splitProviderFork,
                    {
                        world: server.world,
                        ledger,
                        rpcProviders: scenario.rpcProviders,
                        reorgDepth: Number(env.REORG_DEPTH),
                        barrierName: "old-validation",
                        observe: snapshot,
                        eventually,
                        assertAlive: alive,
                    },
                );
                checkpoints.push({
                    name: SPLIT_PROVIDER_EVENT.Healed,
                    splitProviderFork: split,
                });
            }
            for (const action of scenario.schedule ?? DEFAULT_FORK_SCHEDULE) {
                let detail = {};
                switch (action) {
                    case EXTERNAL_ACTION.CanonicalSwitch:
                        if (scenario.splitProviderFork)
                            detail.recoveryInputs = beginSplitProviderRecovery({
                                world: server.world,
                                ledger,
                                reorgDepth: Number(env.REORG_DEPTH),
                                headProgress,
                            });
                        else server.world.switchBranch("B", { head: 107 });
                        if (staleResultCut)
                            checkpoints.push({
                                name: STALE_RESULT_PROPERTY.Rollback,
                                staleResultCut:
                                    await staleResultCut.captureRollback(),
                            });
                        else
                            await eventually(
                                () => snapshot().revision > 0,
                                "actual canonical check and committed rollback",
                                180_000,
                            );
                        detail.committedRevision = snapshot().revision;
                        break;
                    case EXTERNAL_ACTION.ReleaseValidation:
                        if (staleResultCut) {
                            const cut =
                                await staleResultCut.releaseAndAssertRejected();
                            checks[CHECK.StaleResultSafetyCut] = true;
                            activeCheck = CHECK.ReorgRecovery;
                            detail = { staleResultSafetyCut: true };
                            checkpoints.push({
                                name: STALE_RESULT_PROPERTY.Rejected,
                                staleResultCut: cut,
                            });
                        } else server.world.release("old-validation");
                        if (
                            scenario.validationRelease ===
                            VALIDATION_RELEASE.BeforeRollback
                        ) {
                            await eventually(
                                () => {
                                    const current = snapshot();
                                    const bid = current.orders.find(
                                        (row) =>
                                            row.id ===
                                            ledger.orders.bid.orderHash,
                                    );
                                    return (
                                        current.revision === 0 &&
                                        bid?.fillability_status ===
                                            ORDER_STATUS.Cancelled &&
                                        bid?.source_status ===
                                            ORDER_SOURCE_STATUS.Active
                                    );
                                },
                                "actual A105 counter validation committed before the canonical fork switch",
                                90_000,
                            );
                            const committed = snapshot();
                            detail = {
                                committedBeforeRollback: true,
                                chainRevision: committed.revision,
                                order: committed.orders.find(
                                    (row) =>
                                        row.id === ledger.orders.bid.orderHash,
                                ),
                                validation: committed.validationProofs.find(
                                    (row) =>
                                        row.order_id ===
                                        ledger.orders.bid.orderHash,
                                ),
                            };
                            checkpoints.push({
                                name: "a-validation-committed-before-fork",
                                state: committed,
                            });
                        }
                        break;
                    case EXTERNAL_ACTION.RestoreInventory:
                        server.world.market.listings = [
                            ledger.orders.listing.raw,
                        ];
                        break;
                    case EXTERNAL_ACTION.StreamListing:
                        const observedAt = Math.floor(Date.now() / 1000);
                        detail = {
                            deliveredRecipients: server.pushStreamEvent(
                                server.world.streamEventFor("listing", {
                                    observedAt,
                                }),
                            ),
                            observedAt,
                        };
                        assert.ok(
                            detail.deliveredRecipients > 0,
                            "An external stream action must reach a real subscriber",
                        );
                        break;
                    default:
                        throw new Error(
                            `Unimplemented external action ${action}`,
                        );
                }
                server.world.recordAction(action, detail);
            }
            server.world.setPhase("canonical-b");
            if (!scenario.splitProviderFork) headProgress?.start();
            await eventually(
                () => {
                    const current = snapshot();
                    return (
                        current.recovery.length === 0 &&
                        current.owners.some(
                            (row) =>
                                row.token_id === "1" &&
                                row.owner === ledger.addresses.seller,
                        ) &&
                        !current.activities.some(
                            (row) =>
                                row.kind === ACTIVITY_KIND.Sale &&
                                row.block_number >= 104,
                        ) &&
                        current.orders.some(
                            (row) =>
                                row.id === ledger.orders.listing.orderHash &&
                                row.fillability_status ===
                                    ORDER_STATUS.Fillable &&
                                row.validated_at > 0,
                        ) &&
                        current.pendingDemand.length === 0
                    );
                },
                "canonical B state and orderbook convergence",
                180_000,
            );
            const canonicalHttp = await fetchJson(api);
            assert.ok(
                canonicalHttp.tokens.items.some(
                    (token) =>
                        token.tokenId === "1" &&
                        token.listingPrice ===
                            ledger.orders.listing.raw.price.current.value.toString(),
                ),
                "Canonical B observation must restore the current ask through HTTP",
            );
            const canonicalActivity = await fetchJson(`${api}/1/activity`);
            assert.equal(
                canonicalActivity.token.currentHolder,
                ledger.addresses.seller,
            );
            assert.ok(
                !canonicalActivity.activities.items.some(
                    (activity) => activity.kind === ACTIVITY_KIND.Sale,
                ),
                "Orphan sale must be absent from HTTP history",
            );
            checkpoints.push({
                name: "canonical-b",
                state: snapshot(),
                http: canonicalHttp,
                activity: canonicalActivity,
            });
        }
        if (scenario.journey === DATA_PLANE_JOURNEY.ProviderDisagreement) {
            activeCheck = CHECK.ProviderDisagreement;
            checks[activeCheck] = false;
            let property = DISAGREEMENT_PROPERTY.Prelude;
            try {
                await closeSources([
                    RUNTIME_PROCESS.OpenSeaReconcileScheduler,
                    RUNTIME_PROCESS.OpenSeaBootstrap,
                ]);
                server.world.setPhase(DISAGREEMENT_PHASE.Acquisition);
                server.world.advanceHead(104);
                const manager = await broker.connection.jetstreamManager();
                await eventually(
                    async () => {
                        const current = snapshot();
                        const stream = await manager.streams.info(
                            resolveNatsJobStreamName(env.NATS_STREAM_PREFIX),
                        );
                        return (
                            current.owners.some(
                                (row) =>
                                    row.token_id === "1" &&
                                    row.owner === ledger.addresses.buyer,
                            ) &&
                            current.coverage.some(
                                (row) => row.block_number === 104,
                            ) &&
                            current.pendingDemand.length === 0 &&
                            current.pendingOutbox.length === 0 &&
                            current.unfinishedMaker.length === 0 &&
                            current.recovery.length === 0 &&
                            current.canonicalChecks.every(
                                (check) => check.block_number > 102,
                            ) &&
                            stream.state.messages === 0
                        );
                    },
                    "coherent A104 chain and metadata work quiesce before the provider fault is armed",
                    180_000,
                );
                const before = snapshot();
                const orderId = ledger.orders.listing.orderHash;
                const listing = before.orders.find((row) => row.id === orderId);
                assert.equal(
                    listing.seaport_data_source_kind,
                    ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
                    "The target listing must retain its genuine first-stream admission boundary",
                );
                assert.equal(
                    listing.fillability_status,
                    ORDER_STATUS.NoBalance,
                    "Before fault injection the coherent A104 owner cannot fulfill the seller's listing",
                );
                checkpoints.push({
                    name: "provider-disagreement-coherent-prelude",
                    state: before,
                });
                property = DISAGREEMENT_PROPERTY.Admission;
                const latestSource = Math.max(
                    0,
                    ...before.observations
                        .filter((row) => row.order_id === orderId)
                        .map((row) => row.source_event_at ?? 0),
                );
                await eventually(
                    () => Math.floor(Date.now() / 1000) > latestSource,
                    "actual current listing observation newer than prior source evidence",
                    10_000,
                );
                const sourceEventAt = Math.floor(Date.now() / 1000);
                const afterSequence = server.world.trace.at(-1)?.sequence ?? 0;
                server.world.setPhase(DISAGREEMENT_PHASE.Armed);
                const deliveredRecipients = server.pushStreamEvent(
                    server.world.streamEventFor("listing", {
                        observedAt: sourceEventAt,
                    }),
                );
                assert.ok(
                    deliveredRecipients > 0,
                    "The fresh listing must reach a real source subscriber",
                );
                await eventually(
                    () => {
                        const current = snapshot();
                        return (
                            current.orders.some(
                                (row) =>
                                    row.id === orderId &&
                                    row.state_revision >
                                        listing.state_revision &&
                                    row.seaport_data_source_kind ===
                                        ORDER_SEAPORT_DATA_SOURCE_KIND.Stream,
                            ) &&
                            current.observations.some(
                                (row) =>
                                    row.order_id === orderId &&
                                    row.channel ===
                                        OFFCHAIN_OBSERVATION_CHANNEL.Stream &&
                                    row.source_event_at === sourceEventAt,
                            )
                        );
                    },
                    "the genuine first listing stream admission creates a new canonical source revision",
                    60_000,
                );
                property = DISAGREEMENT_PROPERTY.Read;
                let read;
                await eventually(
                    () => {
                        alive();
                        read = completedDisagreementRead(server.world.trace, {
                            afterSequence,
                            minimumBlock: 104,
                        });
                        return !!read;
                    },
                    "the new validator reaches and completes the armed provider fault",
                    90_000,
                );
                // A correct hash-pinned refusal may bypass the script's after
                // effect. Explicitly heal every endpoint before the fair retry.
                healDisagreementProviders(
                    server.world,
                    Object.keys(server.rpcUrls),
                    104,
                );
                checkpoints.push({
                    name: "provider-disagreement-read-and-healing",
                    sourceEventAt,
                    deliveredRecipients,
                    read,
                });
                property = DISAGREEMENT_PROPERTY.Proof;
                let fresh;
                await eventually(
                    () => {
                        const current = snapshot();
                        try {
                            fresh = assertFreshValidatorProof({
                                before,
                                current,
                                orderId,
                                sourceEventAt,
                                minimumBlock: 104,
                            });
                            return true;
                        } catch {
                            return false;
                        }
                    },
                    "a new full proof settles for the fresh source revision after explicit provider healing",
                    120_000,
                );
                checkpoints.push({
                    name: "provider-disagreement-fresh-validator-proof",
                    sourceEventAt,
                    readOutcome: read.outcome,
                    ...fresh,
                });
                providerDisagreementReached = true;
            } catch (error) {
                error.property ??= property;
                throw error;
            }
        }
        // Close source producers through their actual process shutdown boundary,
        // then require retained internal work to settle without more source inputs.
        await closeSources();
        const manager = await broker.connection.jetstreamManager();
        let progressStopped = false;
        await eventually(
            async () => {
                const current = snapshot();
                const stream = await manager.streams.info(
                    resolveNatsJobStreamName(env.NATS_STREAM_PREFIX),
                );
                const head = server.world.providerView("default").head;
                const businessDrained = publishedBusinessWorkDrained(
                    current,
                    stream.state.messages,
                );
                if (businessDrained && headProgress && !progressStopped) {
                    headProgress.stop();
                    progressStopped = true;
                    // Freeze the finite outside world before requiring its last
                    // block and mature checks. A consumer may legally trail an
                    // advancing tip forever while every business job is done.
                    return false;
                }
                return (
                    businessDrained &&
                    current.canonicalChecks.every(
                        (check) => check.block_number > head - 2,
                    ) &&
                    current.coverage.filter(
                        (row) =>
                            row.block_number > acquisitionLedger.anchorBlock,
                    ).length ===
                        head - acquisitionLedger.anchorBlock &&
                    current.headers.some((row) => row.block_number === head)
                );
            },
            "closed-producer durable obligation convergence",
            180_000,
        );
        checkpoints.push({
            name: "settled",
            state: snapshot(),
            http: await fetchJson(api),
        });
        activeCheck = CHECK.ChainAcquisition;
        checks[activeCheck] = false;
        const winningView = server.world.providerView("default");
        assertCanonicalAcquisition({
            snapshot: snapshot(),
            ledger: acquisitionLedger,
            branch: winningView.branch,
            head: winningView.head,
        });
        for (const provider of scenario.rpcProviders ?? ["default"])
            assert.ok(
                server.world.trace.some(
                    (entry) =>
                        entry.type === "request" && entry.provider === provider,
                ),
                `The actual weighted RPC adapter must exercise configured provider ${provider}`,
            );
        checks[activeCheck] = true;
        if (!providerDisagreementReached) {
            activeCheck =
                scenario.journey === DATA_PLANE_JOURNEY.Fork
                    ? CHECK.ReorgRecovery
                    : CHECK.OrderValidation;
            checks[activeCheck] = false;
            assertMarketConvergence({
                snapshot: snapshot(),
                ledger,
                expectedSourceStatuses,
            });
            checks[activeCheck] = true;
        }
        if (providerDisagreementReached) {
            activeCheck = CHECK.ProviderDisagreement;
            const current = snapshot();
            const canonicalOwner = ledger.stateAt("A", 104).owners.get("1");
            assert.equal(canonicalOwner, ledger.addresses.buyer);
            const listing = current.orders.find(
                (order) => order.id === ledger.orders.listing.orderHash,
            );
            const actualHttp = await fetchJson(api);
            checks[CHECK.ProviderDisagreement] =
                listing?.fillability_status === ORDER_STATUS.NoBalance &&
                !actualHttp.tokens.items.some(
                    (token) => token.tokenId === "1" && token.listingPrice,
                );
            checkpoints.push({
                name: "provider-disagreement-oracle",
                canonicalOwner,
                listing,
                http: actualHttp,
                expectedFillability: ORDER_STATUS.NoBalance,
            });
            assert.equal(
                checks[CHECK.ProviderDisagreement],
                true,
                "Validation used a different fork's numeric ownership read: the canonical owner cannot fulfill the seller's listing",
            );
        }
        activeCheck = CHECK.HttpProjection;
        checks[activeCheck] = true;
        for (const expected of scenario.expectedChecks)
            assert.equal(
                checks[expected],
                true,
                `Scenario did not establish required check ${expected}`,
            );
        return {
            checks,
            evidence: {
                processes: processes.map((entry) => ({
                    id: entry.id,
                    artifact: entry.artifact,
                })),
                checkpoints,
                world: server.world.snapshot(),
                runtimeProfile:
                    scenario.runtimeProfile ?? RUNTIME_PROFILE.Unrestricted,
                headProgress: headProgress?.evidence(),
                staleResultCut: staleResultCut?.evidence(),
                ...(nativeDiagnostics
                    ? { nativeDiagnostics: await nativeDiagnostics.capture() }
                    : {}),
                ...scheduleEvidence(server.world),
            },
        };
    } catch (error) {
        const failedCheck = recordDataPlaneFailureChecks(
            error,
            checks,
            activeCheck,
            scenario.expectedChecks,
        );
        const nativeFailure = await captureGuestNativeFailure({
            diagnostics: nativeDiagnostics,
        }).catch((diagnosticError) => ({ error: diagnosticError.message }));
        await writeFile(
            path.join(output, NATIVE_FAILURE_ARTIFACT),
            `${JSON.stringify(nativeFailure, null, 2)}\n`,
        ).catch((diagnosticError) => {
            nativeFailure.artifactError = diagnosticError.message;
        });
        const logTails = await Promise.all(
            processes.map(async (entry) => ({
                process: entry.id,
                stdout: (
                    await readFile(entry.stdoutPath, "utf8").catch(() => "")
                ).slice(-4096),
                stderr: (
                    await readFile(entry.stderrPath, "utf8").catch(() => "")
                ).slice(-4096),
            })),
        );
        const provider = server.world.providerView("default");
        const processStates = await Promise.all(
            processes.map(async (entry) => ({
                id: entry.id,
                pid: entry.child.pid,
                intentionallyStopped: entry.intentionallyStopped ?? false,
                exitCode: entry.child.exitCode,
                signalCode: entry.child.signalCode,
                status: (
                    await readFile(
                        `/proc/${entry.child.pid}/status`,
                        "utf8",
                    ).catch((failure) => `unavailable:${failure.code}`)
                ).slice(0, 4096),
                stat: (
                    await readFile(
                        `/proc/${entry.child.pid}/stat`,
                        "utf8",
                    ).catch((failure) => `unavailable:${failure.code}`)
                ).slice(0, 2048),
                waitChannel: (
                    await readFile(
                        `/proc/${entry.child.pid}/wchan`,
                        "utf8",
                    ).catch((failure) => `unavailable:${failure.code}`)
                ).slice(0, 256),
            })),
        );
        const brokerState = broker
            ? await bounded(
                  (async () => {
                      const manager =
                          await broker.connection.jetstreamManager();
                      const name = resolveNatsJobStreamName(
                          SIMULATION_STREAM_PREFIX,
                      );
                      const stream = await manager.streams.info(name);
                      const consumers = await manager.consumers
                          .list(name)
                          .next();
                      return {
                          stream: name,
                          state: stream.state,
                          consumers: consumers.slice(0, 64).map((consumer) => ({
                              name: consumer.name,
                              filterSubject: consumer.config.filter_subject,
                              pending: consumer.num_pending,
                              ackPending: consumer.num_ack_pending,
                              redelivered: consumer.num_redelivered,
                              ackFloor: consumer.ack_floor,
                              delivered: consumer.delivered,
                          })),
                      };
                  })(),
                  "Diagnostic broker observation timed out",
                  5_000,
              ).catch((failure) => ({ error: failure.message }))
            : null;
        error.simulation = {
            ...(error.simulation ?? {}),
            checks,
            failedCheck,
            failedProperty:
                error.property ?? error.failureProperty ?? activeCheck,
            checkpoints,
            currentState:
                observer && collectionId
                    ? observe(observer, collectionId)
                    : null,
            world: server.world.snapshot(),
            ...scheduleEvidence(server.world),
            headAgeSeconds:
                Math.floor(Date.now() / 1000) -
                ledger.blockAt(provider.branch, provider.head).timestamp,
            requestTrace: server.world.trace.slice(-40),
            logTails,
            processStates,
            nativeFailure,
            brokerState,
            headProgress: headProgress?.evidence(),
        };
        throw error;
    } finally {
        staleResultCut?.abort();
        headProgress?.stop();
        await writeFile(
            path.join(output, "world-trace.json"),
            `${JSON.stringify(server.world.trace, null, 2)}\n`,
        );
        const finalCollection = observer
            ?.prepare("SELECT collection_id FROM collections WHERE slug=?")
            .get(ledger.collectionSlug);
        if (finalCollection)
            await writeFile(
                path.join(output, "last-state.json"),
                `${JSON.stringify(observe(observer, Number(finalCollection.collection_id)), null, 2)}\n`,
            ).catch(() => {});
        for (const process of [...processes].reverse())
            await stopProcess(process.child);
        observer?.close();
        if (broker) await stopBroker(broker);
        await server.close();
    }
}
