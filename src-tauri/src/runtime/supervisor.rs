use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use artgod_sensitive_process::{ChildProcessContainment, prepare_process_containment};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use zeroize::Zeroizing;

use super::app_config::load_app_config_state;
use super::bot_lifecycle::{BotLifecycleCoordinator, BotStartReservation, BotWorkerLifecycleLease};
use crate::desktop_log::{append_child_process_log_line, append_desktop_supervisor_log};
use crate::runtime::bidding_mandate::BiddingMandate;
use crate::runtime::bot_runtime::{
    BOT_RUNTIME_SPECS, BotCriticalDependencyStatus, BotRuntimeSnapshot, BotRuntimeState,
    bot_runtime_spec,
};
use crate::runtime::config::{BotRuntimeLaunchConfig, DesktopRuntimeConfig};
use crate::runtime::process_registry::{
    BACKEND_ARTIFACT, BACKEND_PROCESS_NAME, INDEXER_WORKERS, NATS_PROCESS_NAME,
    SUPERVISOR_PROCESS_NAME,
};
use crate::wallet::domain::BotKind;

/// Enables JetStream for the embedded NATS server.
const NATS_JETSTREAM_ENABLE_ARG: &str = "-js";
/// NATS server port flag used by the embedded runtime supervisor.
const NATS_PORT_ARG: &str = "-p";
/// NATS server storage flag that keeps JetStream data inside app-data.
const NATS_STORE_DIR_ARG: &str = "--store_dir";
const STARTUP_PORT_TIMEOUT: Duration = Duration::from_secs(30);
const STARTUP_RUNTIME_HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const MONITOR_POLL_INTERVAL: Duration = Duration::from_millis(500);
const PROCESS_STOP_GRACE_PERIOD: Duration = Duration::from_secs(30);
const PROCESS_STOP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const STARTUP_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(150);
/// Supervisor lifecycle log level for routine process events.
const SUPERVISOR_LOG_LEVEL_INFO: &str = "info";
/// Supervisor lifecycle log level for recoverable shutdown anomalies.
const SUPERVISOR_LOG_LEVEL_WARN: &str = "warn";
/// Supervisor lifecycle log level for terminal shutdown failures.
const SUPERVISOR_LOG_LEVEL_ERROR: &str = "error";
/// Error returned when the core runtime lifecycle mutex is unavailable.
const RUNTIME_LIFECYCLE_LOCK_ERROR: &str = "Failed to lock runtime lifecycle state";
// Trading bots must quickly prove they entered their managed bootstrap path after unlock/start.
const BOT_START_SIGNAL_TIMEOUT: Duration = Duration::from_secs(30);
// A recipient that does not consume the secret frame must not block Stop or core shutdown.
const BOT_SECRET_HANDOFF_TIMEOUT: Duration = Duration::from_secs(10);
/// Prevents a signal from opening Node's inspector inside a key-bearing process.
const KEY_BEARING_NODE_DISABLE_SIGUSR1_ARG: &str = "--disable-sigusr1";
// Once bootstrapping started, long warmup is allowed as long as the bot keeps reporting progress.
const BOT_BOOTSTRAP_STALL_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: String,
    pub restart_count: u32,
    pub last_error: Option<String>,
    pub running_processes: Vec<String>,
    pub backend_http_base_url: String,
    pub nats_url: String,
    pub config_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEndpoints {
    pub backend_http_base_url: String,
    pub nats_url: String,
}

struct RuntimeController {
    stop_tx: Sender<()>,
    join_handle: JoinHandle<()>,
}

struct BotRuntimeController {
    generation: u64,
    stop_tx: Sender<()>,
    join_handle: JoinHandle<()>,
}

#[derive(Clone)]
struct ManagedBotRuntimeStatus {
    state: BotRuntimeState,
    last_error: Option<String>,
    bidding_mandate: Option<BiddingMandate>,
    lifecycle_generation: Option<u64>,
}

#[derive(Clone)]
pub struct RuntimeManager {
    status: Arc<Mutex<RuntimeStatus>>,
    controller: Arc<Mutex<Option<RuntimeController>>>,
    lifecycle_gate: Arc<Mutex<()>>,
    core_running_since: Arc<Mutex<Option<Instant>>>,
    bot_statuses: Arc<Mutex<HashMap<BotKind, ManagedBotRuntimeStatus>>>,
    bot_controllers: Arc<Mutex<HashMap<BotKind, BotRuntimeController>>>,
    bot_lifecycle: BotLifecycleCoordinator,
}

impl RuntimeManager {
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(RuntimeStatus {
                state: "stopped".to_owned(),
                restart_count: 0,
                last_error: None,
                running_processes: Vec::new(),
                backend_http_base_url: String::new(),
                nats_url: String::new(),
                config_path: String::new(),
            })),
            controller: Arc::new(Mutex::new(None)),
            lifecycle_gate: Arc::new(Mutex::new(())),
            core_running_since: Arc::new(Mutex::new(None)),
            bot_statuses: Arc::new(Mutex::new(HashMap::new())),
            bot_controllers: Arc::new(Mutex::new(HashMap::new())),
            bot_lifecycle: BotLifecycleCoordinator::default(),
        }
    }

    pub fn auto_start(&self, app: AppHandle) -> Result<(), String> {
        let _lifecycle_guard = self.lock_lifecycle()?;
        self.auto_start_locked(app)
    }

    fn auto_start_locked(&self, app: AppHandle) -> Result<(), String> {
        let app_config = load_app_config_state(&app)?;
        if !app_config.configured {
            self.update_status(&app, |status| {
                status.state = "stopped".to_owned();
                status.last_error = None;
                status.running_processes.clear();
                status.config_path = app_config.env_file_path;
            });
            return Ok(());
        }
        if !app_config.auto_launch_on_startup {
            self.update_status(&app, |status| {
                status.state = "stopped".to_owned();
                status.last_error = None;
                status.running_processes.clear();
                status.config_path = app_config.env_file_path;
            });
            return Ok(());
        }
        let config = match DesktopRuntimeConfig::load_or_create(&app) {
            Ok(config) => config,
            Err(error) => {
                self.update_status(&app, |status| {
                    status.state = "stopped".to_owned();
                    status.last_error = Some(error.clone());
                    status.running_processes.clear();
                });
                return Err(error);
            }
        };
        self.update_status(&app, |status| {
            status.backend_http_base_url = config.backend_http_base_url();
            status.nats_url = config.nats_url();
            status.config_path = config.env_file_path.to_string_lossy().into_owned();
            status.last_error = None;
        });
        if !config.auto_start {
            self.update_status(&app, |status| {
                status.state = "stopped".to_owned();
                status.running_processes.clear();
            });
            return Ok(());
        }
        self.start_with_config(app, config).map(|_| ())
    }

    pub fn start(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        let _lifecycle_guard = self.lock_lifecycle()?;
        self.start_locked(app)
    }

    fn start_locked(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        let config = match DesktopRuntimeConfig::load_or_create(&app) {
            Ok(config) => config,
            Err(error) => {
                self.update_status(&app, |status| {
                    status.state = "stopped".to_owned();
                    status.last_error = Some(error.clone());
                    status.running_processes.clear();
                });
                return Err(error);
            }
        };
        self.start_with_config(app, config)
    }

    pub fn stop(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        let _lifecycle_guard = self.lock_lifecycle()?;
        self.stop_locked(app)
    }

    fn stop_locked(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        // Invalidate prompt/decrypt work before waiting for every bot generation to stop.
        self.bot_lifecycle.invalidate_core();
        self.stop_all_bots(&app)?;

        let controller = {
            let mut guard = self
                .controller
                .lock()
                .map_err(|_| "Failed to lock runtime controller state".to_owned())?;
            guard.take()
        };

        if let Some(controller) = controller {
            self.update_status(&app, |status| {
                status.state = "stopping".to_owned();
                status.last_error = None;
            });
            let _ = controller.stop_tx.send(());
            let _ = controller.join_handle.join();
        }

        self.update_status(&app, |status| {
            status.state = "stopped".to_owned();
            status.running_processes.clear();
        });

        self.status()
    }

    /// Restarts the supervised core runtime through the standard stop/start sequence.
    pub fn restart(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        let _lifecycle_guard = self.lock_lifecycle()?;
        self.stop_locked(app.clone())?;
        self.start_locked(app)
    }

    pub fn status(&self) -> Result<RuntimeStatus, String> {
        self.status
            .lock()
            .map(|status| status.clone())
            .map_err(|_| "Failed to lock runtime status".to_owned())
    }

    pub fn endpoints(&self) -> Result<RuntimeEndpoints, String> {
        let status = self.status()?;
        if status.backend_http_base_url.is_empty() || status.nats_url.is_empty() {
            return Err(
                "Runtime endpoints are unavailable: desktop runtime config not initialized"
                    .to_owned(),
            );
        }
        Ok(RuntimeEndpoints {
            backend_http_base_url: status.backend_http_base_url,
            nats_url: status.nats_url,
        })
    }

    pub fn config_path(&self) -> Result<String, String> {
        let status = self.status()?;
        if status.config_path.is_empty() {
            return Err(
                "Runtime config path is unavailable: desktop runtime config not initialized"
                    .to_owned(),
            );
        }
        Ok(status.config_path)
    }

    pub fn list_bot_runtime_snapshots(&self) -> Result<Vec<BotRuntimeSnapshot>, String> {
        let core_status = self.status()?;
        let bot_statuses = self
            .bot_statuses
            .lock()
            .map_err(|_| "Failed to lock bot runtime status".to_owned())?;
        Ok(build_bot_runtime_snapshots(&core_status, &bot_statuses))
    }

    pub fn bot_runtime_state(
        &self,
        bot_kind: BotKind,
    ) -> Result<Option<BotRuntimeSnapshot>, String> {
        Ok(self
            .list_bot_runtime_snapshots()?
            .into_iter()
            .find(|snapshot| snapshot.bot_kind == bot_kind))
    }

    fn start_with_config(
        &self,
        app: AppHandle,
        config: DesktopRuntimeConfig,
    ) -> Result<RuntimeStatus, String> {
        {
            let guard = self
                .controller
                .lock()
                .map_err(|_| "Failed to lock runtime controller state".to_owned())?;
            if guard.is_some() {
                return self.status();
            }
        }

        self.update_status(&app, |status| {
            status.state = "starting".to_owned();
            status.restart_count = 0;
            status.last_error = None;
            status.running_processes.clear();
            status.backend_http_base_url = config.backend_http_base_url();
            status.nats_url = config.nats_url();
            status.config_path = config.env_file_path.to_string_lossy().into_owned();
        });

        let status_ref = Arc::clone(&self.status);
        let core_running_since_ref = Arc::clone(&self.core_running_since);
        let bot_lifecycle = self.bot_lifecycle.clone();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let app_handle = app.clone();
        let join_handle = thread::spawn(move || {
            run_supervisor_loop(
                app_handle,
                config,
                status_ref,
                core_running_since_ref,
                bot_lifecycle,
                stop_rx,
            );
        });

        {
            let mut guard = self
                .controller
                .lock()
                .map_err(|_| "Failed to lock runtime controller state".to_owned())?;
            *guard = Some(RuntimeController {
                stop_tx,
                join_handle,
            });
        }

        self.status()
    }

    fn lock_lifecycle(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.lifecycle_gate
            .lock()
            .map_err(|_| RUNTIME_LIFECYCLE_LOCK_ERROR.to_owned())
    }

    pub fn set_bot_runtime_state(
        &self,
        app: &AppHandle,
        bot_kind: BotKind,
        state: BotRuntimeState,
        last_error: Option<String>,
    ) -> Result<(), String> {
        {
            let mut statuses = self
                .bot_statuses
                .lock()
                .map_err(|_| "Failed to lock bot runtime status".to_owned())?;
            let status = statuses
                .entry(bot_kind)
                .or_insert_with(default_managed_bot_runtime_status);
            status.state = state;
            status.last_error = last_error;
            if !bot_runtime_state_is_active(state) {
                status.bidding_mandate = None;
                status.lifecycle_generation = None;
            }
        }
        self.emit_bot_runtime_state_changed(app, bot_kind)
    }

    /// Atomically reserves one bot generation before native authorization work begins.
    pub(crate) fn begin_bot_unlock(
        &self,
        app: &AppHandle,
        bot_kind: BotKind,
    ) -> Result<BotStartReservation, String> {
        let reservation = self.bot_lifecycle.reserve_start(bot_kind)?;
        self.bot_lifecycle.with_current_start(&reservation, || {
            let mut statuses = self
                .bot_statuses
                .lock()
                .map_err(|_| "Failed to lock bot runtime status".to_owned())?;
            let status = statuses
                .entry(bot_kind)
                .or_insert_with(default_managed_bot_runtime_status);
            // The lifecycle coordinator is authoritative; overwrite any stale visible state.
            status.state = BotRuntimeState::AwaitingUnlock;
            status.last_error = None;
            status.bidding_mandate = None;
            status.lifecycle_generation = Some(reservation.generation());
            Ok(())
        })?;
        if let Err(error) = self.emit_bot_runtime_state_changed(app, bot_kind) {
            if let Ok(mut statuses) = self.bot_statuses.lock() {
                let status = statuses
                    .entry(bot_kind)
                    .or_insert_with(default_managed_bot_runtime_status);
                status.state = BotRuntimeState::Error;
                status.last_error = Some(error.clone());
                status.bidding_mandate = None;
                status.lifecycle_generation = None;
            }
            return Err(error);
        }
        Ok(reservation)
    }

    /// Serializes a stopped-bot metadata mutation against start and stop.
    pub(crate) fn with_idle_bot_mutation<T>(
        &self,
        bot_kind: BotKind,
        mutation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.bot_lifecycle
            .with_idle_bot_mutation(bot_kind, mutation)
    }

    /// Mutates visible state only for the exact pending bot-start generation.
    pub(crate) fn set_reserved_bot_runtime_state(
        &self,
        app: &AppHandle,
        reservation: &BotStartReservation,
        state: BotRuntimeState,
        last_error: Option<String>,
    ) -> Result<(), String> {
        self.bot_lifecycle.with_current_start(reservation, || {
            let mut statuses = self
                .bot_statuses
                .lock()
                .map_err(|_| "Failed to lock bot runtime status".to_owned())?;
            let status = statuses
                .entry(reservation.bot_kind())
                .or_insert_with(default_managed_bot_runtime_status);
            status.state = state;
            status.last_error = last_error;
            if bot_runtime_state_is_active(state) {
                status.lifecycle_generation = Some(reservation.generation());
            } else {
                status.bidding_mandate = None;
                status.lifecycle_generation = None;
            }
            Ok(())
        })?;
        self.emit_bot_runtime_state_changed(app, reservation.bot_kind())
    }

    /// Records the native authority only for the generation that will receive it.
    pub(crate) fn set_reserved_bot_bidding_mandate(
        &self,
        app: &AppHandle,
        reservation: &BotStartReservation,
        bidding_mandate: Option<BiddingMandate>,
    ) -> Result<(), String> {
        let bot_kind = reservation.bot_kind();
        if bot_kind != BotKind::Bidding && bidding_mandate.is_some() {
            return Err("Only the bidding bot may hold a bidding mandate.".to_owned());
        }
        self.bot_lifecycle.with_current_start(reservation, || {
            let mut statuses = self
                .bot_statuses
                .lock()
                .map_err(|_| "Failed to lock bot runtime status".to_owned())?;
            let status = statuses
                .entry(bot_kind)
                .or_insert_with(default_managed_bot_runtime_status);
            status.bidding_mandate = bidding_mandate;
            Ok(())
        })?;
        self.emit_bot_runtime_state_changed(app, bot_kind)
    }

    pub fn clear_bot_runtime_state(
        &self,
        app: &AppHandle,
        bot_kind: BotKind,
    ) -> Result<(), String> {
        {
            let mut statuses = self
                .bot_statuses
                .lock()
                .map_err(|_| "Failed to lock bot runtime status".to_owned())?;
            statuses.remove(&bot_kind);
        }
        self.emit_bot_runtime_state_changed(app, bot_kind)
    }

    pub fn wait_until_bot_dependencies_stable(
        &self,
        reservation: &BotStartReservation,
        stabilization_delay_ms: u64,
    ) -> Result<(), String> {
        loop {
            reservation.validate()?;
            self.validate_bot_dependencies_now(reservation.bot_kind())?;

            let running_since = self
                .core_running_since
                .lock()
                .map_err(|_| "Failed to read core runtime stability window".to_owned())?
                .to_owned();
            let Some(running_since) = running_since else {
                return Err("Core runtime stability window is unavailable.".to_owned());
            };
            let elapsed = Instant::now().saturating_duration_since(running_since);
            let required = Duration::from_millis(stabilization_delay_ms);
            if elapsed >= required {
                return Ok(());
            }
            thread::sleep((required - elapsed).min(Duration::from_millis(100)));
        }
    }

    /// Rechecks the bot/core generation and dependencies without another stability wait.
    pub(crate) fn validate_bot_start(
        &self,
        reservation: &BotStartReservation,
    ) -> Result<(), String> {
        reservation.validate()?;
        self.validate_bot_dependencies_now(reservation.bot_kind())
    }

    pub(crate) fn start_bot_runtime(
        &self,
        app: AppHandle,
        reservation: &BotStartReservation,
        launch_config: BotRuntimeLaunchConfig,
        secret_envelope: Zeroizing<Vec<u8>>,
    ) -> Result<(), String> {
        let bot_kind = launch_config.spec.bot_kind;
        if reservation.bot_kind() != bot_kind {
            return Err("Bot start reservation does not match its launch config.".to_owned());
        }

        let spec = launch_config.spec;
        let worker_lease = reservation.worker_lease();
        let generation = worker_lease.generation();
        let app_handle = app.clone();
        let status_ref = Arc::clone(&self.status);
        let bot_statuses_ref = Arc::clone(&self.bot_statuses);
        let bot_controllers_ref = Arc::clone(&self.bot_controllers);
        let bot_lifecycle = self.bot_lifecycle.clone();
        let worker_lifecycle = bot_lifecycle.clone();
        self.bot_lifecycle.commit_start(reservation, || {
            // Commit only while the core and every declared dependency are still available.
            self.validate_bot_dependencies_now(bot_kind)?;
            let mut controllers = self
                .bot_controllers
                .lock()
                .map_err(|_| "Failed to lock bot runtime controllers".to_owned())?;
            if controllers.contains_key(&bot_kind) {
                return Err(format!("{bot_kind:?} bot is already active."));
            }

            let (start_tx, start_rx) = mpsc::channel::<()>();
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let join_handle = thread::Builder::new()
                .spawn(move || {
                    if start_rx.recv().is_ok() {
                        run_bot_runtime_loop(
                            app_handle,
                            launch_config,
                            status_ref,
                            bot_statuses_ref,
                            worker_lease,
                            stop_rx,
                            secret_envelope,
                        );
                    }
                    if let Ok(mut controllers) = bot_controllers_ref.lock()
                        && controllers
                            .get(&spec.bot_kind)
                            .is_some_and(|controller| controller.generation == generation)
                    {
                        controllers.remove(&spec.bot_kind);
                    }
                    worker_lifecycle.finish_controller(spec.bot_kind, generation);
                })
                .map_err(|error| format!("Failed to spawn bot supervisor thread: {error}"))?;

            controllers.insert(
                bot_kind,
                BotRuntimeController {
                    generation,
                    stop_tx,
                    join_handle,
                },
            );
            // Release the worker while stop is excluded and active ownership is already fenced.
            if start_tx.send(()).is_err() {
                let controller = controllers.remove(&bot_kind);
                drop(controllers);
                if let Some(controller) = controller {
                    let _ = controller.stop_tx.send(());
                    drop(controller.join_handle);
                }
                return Err("Bot supervisor stopped before process startup.".to_owned());
            }
            Ok(())
        })?;

        Ok(())
    }

    pub fn stop_bot_runtime(&self, app: &AppHandle, bot_kind: BotKind) -> Result<(), String> {
        let _stop_reservation = self.bot_lifecycle.reserve_stop(bot_kind)?;
        let controller = {
            let mut controllers = self
                .bot_controllers
                .lock()
                .map_err(|_| "Failed to lock bot runtime controllers".to_owned())?;
            controllers.remove(&bot_kind)
        };

        if let Some(controller) = controller {
            let _ = controller.stop_tx.send(());
            let _ = controller.join_handle.join();
        }
        self.set_bot_runtime_state(app, bot_kind, BotRuntimeState::Stopped, None)?;

        Ok(())
    }

    fn stop_all_bots(&self, app: &AppHandle) -> Result<(), String> {
        for spec in BOT_RUNTIME_SPECS {
            self.stop_bot_runtime(app, spec.bot_kind)?;
        }
        Ok(())
    }

    fn validate_bot_dependencies_now(&self, bot_kind: BotKind) -> Result<(), String> {
        let spec = bot_runtime_spec(bot_kind);
        let status = self.status()?;
        if status.state != "running" {
            return Err("Core runtime is not running.".to_owned());
        }
        for process in spec.critical_processes {
            if !status
                .running_processes
                .iter()
                .any(|running| running == process)
            {
                return Err(format!(
                    "Critical dependency is unavailable for {bot_kind:?}: {process}"
                ));
            }
        }
        Ok(())
    }

    fn emit_bot_runtime_state_changed(
        &self,
        app: &AppHandle,
        bot_kind: BotKind,
    ) -> Result<(), String> {
        let core_status = self.status()?;
        let bot_statuses = self
            .bot_statuses
            .lock()
            .map_err(|_| "Failed to lock bot runtime status".to_owned())?;
        if let Some(snapshot) = build_bot_runtime_snapshot(&core_status, &bot_statuses, bot_kind) {
            let _ = app.emit("bot-runtime-state-changed", &snapshot);
        }
        Ok(())
    }

    fn update_status<F>(&self, app: &AppHandle, update: F)
    where
        F: FnOnce(&mut RuntimeStatus),
    {
        update_status(&self.status, app, update);
    }
}

fn run_supervisor_loop(
    app: AppHandle,
    config: DesktopRuntimeConfig,
    status_ref: Arc<Mutex<RuntimeStatus>>,
    core_running_since_ref: Arc<Mutex<Option<Instant>>>,
    bot_lifecycle: BotLifecycleCoordinator,
    stop_rx: Receiver<()>,
) {
    let mut restart_count: u32 = 0;
    let stop_signal = AtomicBool::new(false);
    emit_supervisor_log(
        &app,
        &config.logs_dir,
        "info",
        &format!(
            "Runtime supervisor started (runtime_dir={}, logs_dir={})",
            config.runtime_dir.display(),
            config.logs_dir.display()
        ),
    );

    loop {
        // Every core startup/restart is a new generation for wallet-bound bot starts.
        bot_lifecycle.invalidate_core();
        update_status(&status_ref, &app, |status| {
            status.state = if restart_count == 0 {
                "starting".to_owned()
            } else {
                "restarting".to_owned()
            };
            status.restart_count = restart_count;
            status.last_error = None;
            status.running_processes.clear();
        });
        set_core_running_since(&core_running_since_ref, None);

        let mut processes = match spawn_runtime_processes(&app, &config, &stop_rx, &stop_signal) {
            Ok(processes) => processes,
            Err(SpawnRuntimeError::Cancelled) => {
                emit_supervisor_log(
                    &app,
                    &config.logs_dir,
                    "info",
                    "Stop requested during startup; supervisor stopping",
                );
                update_status(&status_ref, &app, |status| {
                    status.state = "stopped".to_owned();
                    status.running_processes.clear();
                });
                set_core_running_since(&core_running_since_ref, None);
                break;
            }
            Err(SpawnRuntimeError::Failed(error)) => {
                restart_count = restart_count.saturating_add(1);
                emit_supervisor_log(
                    &app,
                    &config.logs_dir,
                    "error",
                    &format!("Runtime startup failed: {error}"),
                );
                update_status(&status_ref, &app, |status| {
                    status.state = "restarting".to_owned();
                    status.restart_count = restart_count;
                    status.last_error = Some(error.clone());
                    status.running_processes.clear();
                });
                set_core_running_since(&core_running_since_ref, None);
                if stop_requested(&stop_rx, &stop_signal) {
                    emit_supervisor_log(
                        &app,
                        &config.logs_dir,
                        "info",
                        "Stop requested during startup retry; supervisor stopping",
                    );
                    update_status(&status_ref, &app, |status| {
                        status.state = "stopped".to_owned();
                        status.running_processes.clear();
                    });
                    set_core_running_since(&core_running_since_ref, None);
                    break;
                }
                if sleep_with_stop(
                    &stop_rx,
                    &stop_signal,
                    Duration::from_millis(config.restart_backoff_ms),
                ) {
                    emit_supervisor_log(
                        &app,
                        &config.logs_dir,
                        "info",
                        "Stop requested during startup backoff; supervisor stopping",
                    );
                    update_status(&status_ref, &app, |status| {
                        status.state = "stopped".to_owned();
                        status.running_processes.clear();
                    });
                    set_core_running_since(&core_running_since_ref, None);
                    break;
                }
                continue;
            }
        };

        let running_names = processes
            .iter()
            .map(|process| process.name.clone())
            .collect::<Vec<_>>();
        update_status(&status_ref, &app, |status| {
            status.state = "running".to_owned();
            status.restart_count = restart_count;
            status.last_error = None;
            status.running_processes = running_names;
        });
        set_core_running_since(&core_running_since_ref, Some(Instant::now()));
        emit_supervisor_log(
            &app,
            &config.logs_dir,
            "info",
            "Runtime processes are running",
        );

        let monitor_outcome = monitor_processes(&mut processes, &stop_rx, &stop_signal);
        // Cancel native prompts immediately when a running core generation ends.
        bot_lifecycle.invalidate_core();
        match monitor_outcome {
            MonitorOutcome::StoppedByRequest => {
                emit_supervisor_log(
                    &app,
                    &config.logs_dir,
                    "info",
                    "Stop requested; shutting down all runtime processes",
                );
                stop_all_processes(&app, &config.logs_dir, &mut processes);
                update_status(&status_ref, &app, |status| {
                    status.state = "stopped".to_owned();
                    status.running_processes.clear();
                });
                set_core_running_since(&core_running_since_ref, None);
                break;
            }
            MonitorOutcome::ProcessExited { process, status } => {
                let error = format!("Process {process} exited unexpectedly: {status}");
                emit_supervisor_log(&app, &config.logs_dir, "error", &error);
                stop_all_processes(&app, &config.logs_dir, &mut processes);
                restart_count = restart_count.saturating_add(1);
                update_status(&status_ref, &app, |status_ref| {
                    status_ref.state = "restarting".to_owned();
                    status_ref.restart_count = restart_count;
                    status_ref.last_error = Some(error);
                    status_ref.running_processes.clear();
                });
                set_core_running_since(&core_running_since_ref, None);
                if sleep_with_stop(
                    &stop_rx,
                    &stop_signal,
                    Duration::from_millis(config.restart_backoff_ms),
                ) {
                    emit_supervisor_log(
                        &app,
                        &config.logs_dir,
                        "info",
                        "Stop requested during restart backoff; supervisor stopping",
                    );
                    update_status(&status_ref, &app, |status| {
                        status.state = "stopped".to_owned();
                        status.running_processes.clear();
                    });
                    set_core_running_since(&core_running_since_ref, None);
                    break;
                }
            }
            MonitorOutcome::ProcessFailure { process, error } => {
                let details = format!("Process {process} monitor failure: {error}");
                emit_supervisor_log(&app, &config.logs_dir, "error", &details);
                stop_all_processes(&app, &config.logs_dir, &mut processes);
                restart_count = restart_count.saturating_add(1);
                update_status(&status_ref, &app, |status_ref| {
                    status_ref.state = "restarting".to_owned();
                    status_ref.restart_count = restart_count;
                    status_ref.last_error = Some(details);
                    status_ref.running_processes.clear();
                });
                set_core_running_since(&core_running_since_ref, None);
                if sleep_with_stop(
                    &stop_rx,
                    &stop_signal,
                    Duration::from_millis(config.restart_backoff_ms),
                ) {
                    emit_supervisor_log(
                        &app,
                        &config.logs_dir,
                        "info",
                        "Stop requested during restart backoff; supervisor stopping",
                    );
                    update_status(&status_ref, &app, |status| {
                        status.state = "stopped".to_owned();
                        status.running_processes.clear();
                    });
                    set_core_running_since(&core_running_since_ref, None);
                    break;
                }
            }
        }
    }
}

fn set_core_running_since(
    core_running_since_ref: &Arc<Mutex<Option<Instant>>>,
    value: Option<Instant>,
) {
    if let Ok(mut running_since) = core_running_since_ref.lock() {
        *running_since = value;
    }
}

fn build_bot_runtime_snapshots(
    core_status: &RuntimeStatus,
    bot_statuses: &HashMap<BotKind, ManagedBotRuntimeStatus>,
) -> Vec<BotRuntimeSnapshot> {
    BOT_RUNTIME_SPECS
        .iter()
        .map(|spec| build_bot_runtime_snapshot_from_spec(core_status, bot_statuses, spec))
        .collect()
}

fn build_bot_runtime_snapshot(
    core_status: &RuntimeStatus,
    bot_statuses: &HashMap<BotKind, ManagedBotRuntimeStatus>,
    bot_kind: BotKind,
) -> Option<BotRuntimeSnapshot> {
    BOT_RUNTIME_SPECS
        .iter()
        .find(|spec| spec.bot_kind == bot_kind)
        .map(|spec| build_bot_runtime_snapshot_from_spec(core_status, bot_statuses, spec))
}

fn build_bot_runtime_snapshot_from_spec(
    core_status: &RuntimeStatus,
    bot_statuses: &HashMap<BotKind, ManagedBotRuntimeStatus>,
    spec: &crate::runtime::bot_runtime::BotRuntimeSpec,
) -> BotRuntimeSnapshot {
    let status = bot_statuses
        .get(&spec.bot_kind)
        .cloned()
        .unwrap_or_else(default_managed_bot_runtime_status);

    BotRuntimeSnapshot {
        bot_kind: spec.bot_kind,
        process_name: spec.process_name.to_owned(),
        state: status.state,
        last_error: status.last_error,
        bidding_mandate: status.bidding_mandate,
        critical_dependencies: spec
            .critical_processes
            .iter()
            .map(|process| BotCriticalDependencyStatus {
                process: (*process).to_owned(),
                healthy: core_status.state == "running"
                    && core_status
                        .running_processes
                        .iter()
                        .any(|running| running == process),
            })
            .collect(),
    }
}

fn run_bot_runtime_loop(
    app: AppHandle,
    config: BotRuntimeLaunchConfig,
    status_ref: Arc<Mutex<RuntimeStatus>>,
    bot_statuses_ref: Arc<Mutex<HashMap<BotKind, ManagedBotRuntimeStatus>>>,
    worker_lease: BotWorkerLifecycleLease,
    stop_rx: Receiver<()>,
    secret_envelope: Zeroizing<Vec<u8>>,
) {
    let spec = config.spec;
    let bot_statuses_ref = GenerationBotStatuses {
        statuses: bot_statuses_ref,
        generation: worker_lease.generation(),
    };

    if worker_lease.is_cancelled() {
        update_bot_runtime_state(
            &app,
            &status_ref,
            &bot_statuses_ref,
            spec.bot_kind,
            BotRuntimeState::Stopped,
            None,
        );
        return;
    }

    let mut process = match spawn_trading_bot_process(&app, &config) {
        Ok(process) => process,
        Err(error) => {
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Error,
                Some(error),
            );
            return;
        }
    };

    if worker_lease.is_cancelled() {
        stop_all_processes(
            &app,
            &config.logs_dir,
            std::slice::from_mut(&mut process.process),
        );
        update_bot_runtime_state(
            &app,
            &status_ref,
            &bot_statuses_ref,
            spec.bot_kind,
            BotRuntimeState::Stopped,
            None,
        );
        return;
    }

    match deliver_bot_secret_envelope(
        &mut process.process.child,
        &mut process.stdin,
        &stop_rx,
        &worker_lease,
        secret_envelope,
        BOT_SECRET_HANDOFF_TIMEOUT,
    ) {
        BotSecretDeliveryOutcome::Delivered => {}
        BotSecretDeliveryOutcome::StoppedByRequest => {
            stop_all_processes(
                &app,
                &config.logs_dir,
                std::slice::from_mut(&mut process.process),
            );
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Stopped,
                None,
            );
            return;
        }
        BotSecretDeliveryOutcome::Failed(error) => {
            stop_all_processes(
                &app,
                &config.logs_dir,
                std::slice::from_mut(&mut process.process),
            );
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Error,
                Some(error),
            );
            return;
        }
    }

    if bot_stop_requested(&stop_rx, &worker_lease) {
        stop_all_processes(
            &app,
            &config.logs_dir,
            std::slice::from_mut(&mut process.process),
        );
        update_bot_runtime_state(
            &app,
            &status_ref,
            &bot_statuses_ref,
            spec.bot_kind,
            BotRuntimeState::Stopped,
            None,
        );
        return;
    }

    match wait_for_bot_start_signal(
        &status_ref,
        spec,
        &mut process.process.child,
        &process.lifecycle_rx,
        &stop_rx,
        &worker_lease,
        BOT_START_SIGNAL_TIMEOUT,
    ) {
        BotStartOutcome::Bootstrapping(payload) => {
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Bootstrapping,
                None,
            );
            emit_supervisor_log(
                &app,
                &config.logs_dir,
                "info",
                &format!(
                    "{} entered bootstrapping ({})",
                    spec.process_name,
                    payload.bootstrap_summary()
                ),
            );

            match wait_for_bot_ready_after_bootstrap_start(
                &status_ref,
                spec,
                &mut process.process.child,
                &process.lifecycle_rx,
                &stop_rx,
                &worker_lease,
                BOT_BOOTSTRAP_STALL_TIMEOUT,
            ) {
                BotBootstrapOutcome::Ready(payload) => {
                    update_bot_runtime_state(
                        &app,
                        &status_ref,
                        &bot_statuses_ref,
                        spec.bot_kind,
                        BotRuntimeState::Running,
                        None,
                    );
                    emit_supervisor_log(
                        &app,
                        &config.logs_dir,
                        "info",
                        &format!(
                            "{} reported ready ({})",
                            spec.process_name,
                            payload.readiness_fields()
                        ),
                    );
                }
                BotBootstrapOutcome::StoppedByRequest => {
                    stop_all_processes(
                        &app,
                        &config.logs_dir,
                        std::slice::from_mut(&mut process.process),
                    );
                    update_bot_runtime_state(
                        &app,
                        &status_ref,
                        &bot_statuses_ref,
                        spec.bot_kind,
                        BotRuntimeState::Stopped,
                        None,
                    );
                    return;
                }
                BotBootstrapOutcome::BootstrapFailure(error) => {
                    stop_all_processes(
                        &app,
                        &config.logs_dir,
                        std::slice::from_mut(&mut process.process),
                    );
                    update_bot_runtime_state(
                        &app,
                        &status_ref,
                        &bot_statuses_ref,
                        spec.bot_kind,
                        BotRuntimeState::Error,
                        Some(error),
                    );
                    return;
                }
                BotBootstrapOutcome::CriticalDependencyUnavailable {
                    process: dependency,
                } => {
                    stop_all_processes(
                        &app,
                        &config.logs_dir,
                        std::slice::from_mut(&mut process.process),
                    );
                    update_bot_runtime_state(
                        &app,
                        &status_ref,
                        &bot_statuses_ref,
                        spec.bot_kind,
                        BotRuntimeState::Error,
                        Some(format!(
                            "{} lost critical dependency during bootstrapping: {}",
                            spec.process_name, dependency
                        )),
                    );
                    return;
                }
                BotBootstrapOutcome::ProcessExited { status } => {
                    let error = format!(
                        "{} exited during bootstrapping: {status}",
                        spec.process_name
                    );
                    stop_all_processes(
                        &app,
                        &config.logs_dir,
                        std::slice::from_mut(&mut process.process),
                    );
                    update_bot_runtime_state(
                        &app,
                        &status_ref,
                        &bot_statuses_ref,
                        spec.bot_kind,
                        BotRuntimeState::Error,
                        Some(error),
                    );
                    return;
                }
                BotBootstrapOutcome::ProcessFailure { error } => {
                    stop_all_processes(
                        &app,
                        &config.logs_dir,
                        std::slice::from_mut(&mut process.process),
                    );
                    update_bot_runtime_state(
                        &app,
                        &status_ref,
                        &bot_statuses_ref,
                        spec.bot_kind,
                        BotRuntimeState::Error,
                        Some(error),
                    );
                    return;
                }
            }
        }
        BotStartOutcome::Ready(payload) => {
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Running,
                None,
            );
            emit_supervisor_log(
                &app,
                &config.logs_dir,
                "info",
                &format!(
                    "{} reported ready ({})",
                    spec.process_name,
                    payload.readiness_fields()
                ),
            );
        }
        BotStartOutcome::StoppedByRequest => {
            stop_all_processes(
                &app,
                &config.logs_dir,
                std::slice::from_mut(&mut process.process),
            );
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Stopped,
                None,
            );
            return;
        }
        BotStartOutcome::StartupFailure(error) => {
            stop_all_processes(
                &app,
                &config.logs_dir,
                std::slice::from_mut(&mut process.process),
            );
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Error,
                Some(error),
            );
            return;
        }
        BotStartOutcome::ProcessExited { status } => {
            let error = format!(
                "{} exited before bootstrapping or readiness: {status}",
                spec.process_name
            );
            stop_all_processes(
                &app,
                &config.logs_dir,
                std::slice::from_mut(&mut process.process),
            );
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Error,
                Some(error),
            );
            return;
        }
        BotStartOutcome::ProcessFailure { error } => {
            stop_all_processes(
                &app,
                &config.logs_dir,
                std::slice::from_mut(&mut process.process),
            );
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Error,
                Some(error),
            );
            return;
        }
    }

    match monitor_bot_process(
        &status_ref,
        spec,
        &mut process.process,
        &stop_rx,
        &worker_lease,
    ) {
        BotMonitorOutcome::StoppedByRequest => {
            stop_all_processes(
                &app,
                &config.logs_dir,
                std::slice::from_mut(&mut process.process),
            );
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Stopped,
                None,
            );
        }
        BotMonitorOutcome::CriticalDependencyUnavailable {
            process: dependency_process,
        } => {
            stop_all_processes(
                &app,
                &config.logs_dir,
                std::slice::from_mut(&mut process.process),
            );
            let error = format!("Critical dependency became unavailable: {dependency_process}");
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Error,
                Some(error),
            );
        }
        BotMonitorOutcome::ProcessExited { status } => {
            let error = format!("{} exited unexpectedly: {status}", spec.process_name);
            stop_all_processes(
                &app,
                &config.logs_dir,
                std::slice::from_mut(&mut process.process),
            );
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Error,
                Some(error),
            );
        }
        BotMonitorOutcome::ProcessFailure { error } => {
            let details = format!("{} monitor failure: {error}", spec.process_name);
            stop_all_processes(
                &app,
                &config.logs_dir,
                std::slice::from_mut(&mut process.process),
            );
            update_bot_runtime_state(
                &app,
                &status_ref,
                &bot_statuses_ref,
                spec.bot_kind,
                BotRuntimeState::Error,
                Some(details),
            );
        }
    }
}

fn update_bot_runtime_state(
    app: &AppHandle,
    status_ref: &Arc<Mutex<RuntimeStatus>>,
    bot_statuses_ref: &GenerationBotStatuses,
    bot_kind: BotKind,
    state: BotRuntimeState,
    last_error: Option<String>,
) {
    if let Ok(mut bot_statuses) = bot_statuses_ref.statuses.lock() {
        let status = bot_statuses
            .entry(bot_kind)
            .or_insert_with(default_managed_bot_runtime_status);
        if status.lifecycle_generation != Some(bot_statuses_ref.generation) {
            return;
        }
        status.state = state;
        status.last_error = last_error;
        if bot_runtime_state_is_active(state) {
            status.lifecycle_generation = Some(bot_statuses_ref.generation);
        } else {
            status.bidding_mandate = None;
            status.lifecycle_generation = None;
        }
        if let Ok(core_status) = status_ref.lock()
            && let Some(snapshot) =
                build_bot_runtime_snapshot(&core_status, &bot_statuses, bot_kind)
        {
            let _ = app.emit("bot-runtime-state-changed", &snapshot);
        }
    }
}

struct GenerationBotStatuses {
    statuses: Arc<Mutex<HashMap<BotKind, ManagedBotRuntimeStatus>>>,
    generation: u64,
}

fn default_managed_bot_runtime_status() -> ManagedBotRuntimeStatus {
    ManagedBotRuntimeStatus {
        state: BotRuntimeState::Disabled,
        last_error: None,
        bidding_mandate: None,
        lifecycle_generation: None,
    }
}

fn bot_runtime_state_is_active(state: BotRuntimeState) -> bool {
    matches!(
        state,
        BotRuntimeState::AwaitingUnlock
            | BotRuntimeState::Starting
            | BotRuntimeState::Bootstrapping
            | BotRuntimeState::Running
    )
}

struct SpawnedBotProcess {
    process: ManagedProcess,
    stdin: Option<ChildStdin>,
    _containment: ChildProcessContainment,
    lifecycle_rx: Receiver<Result<BotLifecyclePayload, String>>,
}

struct ContainedTradingBotChild {
    child: Child,
    parent_liveness: Option<ChildStdin>,
    containment: ChildProcessContainment,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotLifecyclePayload {
    event: String,
    bot_kind: BotKind,
    wallet_id: String,
    address: String,
    chain_id: u64,
    phase: Option<String>,
    completed: Option<u64>,
    total: Option<u64>,
    detail: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BotLifecycleKind {
    Bootstrapping,
    BootstrapProgress,
    Ready,
}

impl BotLifecyclePayload {
    fn kind(&self) -> Option<BotLifecycleKind> {
        match self.event.as_str() {
            "bot_bootstrapping" => Some(BotLifecycleKind::Bootstrapping),
            "bot_bootstrap_progress" => Some(BotLifecycleKind::BootstrapProgress),
            "bot_ready" => Some(BotLifecycleKind::Ready),
            _ => None,
        }
    }

    fn readiness_fields(&self) -> String {
        format!(
            "wallet_id={}, address={}, chain_id={}",
            self.wallet_id, self.address, self.chain_id
        )
    }

    fn bootstrap_summary(&self) -> String {
        let phase = self.phase.as_deref().unwrap_or("unknown");
        let completed = self
            .completed
            .map(|value| value.to_string())
            .unwrap_or_else(|| "?".to_owned());
        let total = self
            .total
            .map(|value| value.to_string())
            .unwrap_or_else(|| "?".to_owned());
        let detail = self.detail.as_deref().unwrap_or("none");
        format!("phase={phase}, completed={completed}/{total}, detail={detail}")
    }
}

fn spawn_trading_bot_process(
    app: &AppHandle,
    config: &BotRuntimeLaunchConfig,
) -> Result<SpawnedBotProcess, String> {
    let spec = config.spec;

    let args = build_trading_bot_process_args(config);
    let command_line = render_command_line(config.node_bin.to_string_lossy().as_ref(), &args);
    emit_supervisor_log(
        app,
        &config.logs_dir,
        "info",
        &format!(
            "Spawning process {} with command: {command_line}",
            spec.process_name
        ),
    );

    let ContainedTradingBotChild {
        mut child,
        parent_liveness,
        containment,
    } = spawn_contained_trading_bot_child(config, &args)?;
    emit_supervisor_log(
        app,
        &config.logs_dir,
        "info",
        &format!("Process {} started (pid={})", spec.process_name, child.id()),
    );

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Process {} stdout pipe is unavailable", spec.process_name))?;
    let stderr = child.stderr.take();
    let (lifecycle_tx, lifecycle_rx) = mpsc::channel::<Result<BotLifecyclePayload, String>>();
    let mut output_threads = vec![spawn_bot_stdout_worker(
        app.clone(),
        config.logs_dir.clone(),
        spec.process_name.to_owned(),
        spec.bot_kind,
        stdout,
        lifecycle_tx,
    )];
    if let Some(stderr) = stderr {
        output_threads.push(spawn_log_stream_worker(
            app.clone(),
            config.logs_dir.clone(),
            spec.process_name.to_owned(),
            "stderr",
            stderr,
        ));
    }

    Ok(SpawnedBotProcess {
        process: ManagedProcess {
            name: spec.process_name.to_owned(),
            child,
            output_threads,
            cleanup: None,
        },
        stdin: parent_liveness,
        _containment: containment,
        lifecycle_rx,
    })
}

fn build_trading_bot_process_args(config: &BotRuntimeLaunchConfig) -> Vec<String> {
    let mut args = vec![KEY_BEARING_NODE_DISABLE_SIGUSR1_ARG.to_owned()];
    args.extend(build_node_process_args(
        &config.pnp_cjs_path,
        &config.pnp_loader_path,
        &config.artifact_path,
    ));
    args
}

/// Replaces ambient parent variables with the frozen ArtGod bot environment.
fn configure_key_bearing_node_environment(
    command: &mut Command,
    process_env: &HashMap<String, String>,
) {
    // Prevent launcher-controlled Node and dynamic-loader settings from running before key intake.
    command.env_clear();
    command.envs(process_env);
}

fn spawn_contained_trading_bot_child(
    config: &BotRuntimeLaunchConfig,
    args: &[String],
) -> Result<ContainedTradingBotChild, String> {
    let spec = config.spec;
    let mut command = Command::new(&config.node_bin);
    command
        .args(args)
        .current_dir(&config.runtime_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_key_bearing_node_environment(&mut command, &config.process_env);

    let prepared_containment = prepare_process_containment(&mut command).map_err(|error| {
        format!(
            "Failed to prepare process containment for {}: {error}",
            spec.process_name
        )
    })?;
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Failed to spawn process {} via {} {}: {error}",
            spec.process_name,
            config.node_bin.display(),
            args.join(" ")
        )
    })?;
    let containment = prepared_containment.attach(&mut child).map_err(|error| {
        format!(
            "Failed to contain process {} after spawn: {error}",
            spec.process_name
        )
    })?;
    // Take and retain the only parent-side writer immediately after containment attaches.
    let parent_liveness = child.stdin.take();
    Ok(ContainedTradingBotChild {
        child,
        parent_liveness,
        containment,
    })
}

struct BotSecretHandoff {
    result_rx: Receiver<Result<ChildStdin, String>>,
    join_handle: JoinHandle<()>,
}

enum BotSecretHandoffOutcome {
    Completed(ChildStdin),
    StoppedByRequest,
    Failed(String),
    ProcessExited(ExitStatus),
    TimedOut,
}

enum BotSecretDeliveryOutcome {
    Delivered,
    StoppedByRequest,
    Failed(String),
}

fn deliver_bot_secret_envelope(
    child: &mut Child,
    parent_liveness: &mut Option<ChildStdin>,
    stop_rx: &Receiver<()>,
    worker_lease: &BotWorkerLifecycleLease,
    secret_envelope: Zeroizing<Vec<u8>>,
    timeout: Duration,
) -> BotSecretDeliveryOutcome {
    let handoff = match start_bot_secret_handoff(parent_liveness.take(), secret_envelope) {
        Ok(handoff) => handoff,
        Err(error) => {
            let cleanup_error = terminate_bot_during_secret_handoff(child).err();
            return BotSecretDeliveryOutcome::Failed(join_handoff_errors(error, cleanup_error));
        }
    };

    match wait_for_bot_secret_handoff(child, &handoff.result_rx, stop_rx, worker_lease, timeout) {
        BotSecretHandoffOutcome::Completed(stdin) => {
            if let Err(error) = join_bot_secret_handoff(handoff) {
                let cleanup_error = terminate_bot_during_secret_handoff(child).err();
                return BotSecretDeliveryOutcome::Failed(join_handoff_errors(error, cleanup_error));
            }
            *parent_liveness = Some(stdin);
            BotSecretDeliveryOutcome::Delivered
        }
        BotSecretHandoffOutcome::StoppedByRequest => {
            match abort_bot_secret_handoff(child, handoff) {
                Ok(()) => BotSecretDeliveryOutcome::StoppedByRequest,
                Err(error) => BotSecretDeliveryOutcome::Failed(error),
            }
        }
        BotSecretHandoffOutcome::Failed(error) => {
            let cleanup_error = abort_bot_secret_handoff(child, handoff).err();
            BotSecretDeliveryOutcome::Failed(join_handoff_errors(error, cleanup_error))
        }
        BotSecretHandoffOutcome::ProcessExited(status) => {
            let cleanup_error = abort_bot_secret_handoff(child, handoff).err();
            BotSecretDeliveryOutcome::Failed(join_handoff_errors(
                format!("Trading bot exited during secret handoff: {status}"),
                cleanup_error,
            ))
        }
        BotSecretHandoffOutcome::TimedOut => {
            let cleanup_error = abort_bot_secret_handoff(child, handoff).err();
            BotSecretDeliveryOutcome::Failed(join_handoff_errors(
                format!(
                    "Trading bot did not consume its secret frame within {}s",
                    timeout.as_secs()
                ),
                cleanup_error,
            ))
        }
    }
}

fn start_bot_secret_handoff(
    stdin: Option<ChildStdin>,
    secret_envelope: Zeroizing<Vec<u8>>,
) -> Result<BotSecretHandoff, String> {
    let Some(mut stdin) = stdin else {
        return Err("Trading bot stdin pipe is unavailable".to_owned());
    };

    let (result_tx, result_rx) = mpsc::channel();
    let join_handle = thread::Builder::new()
        .spawn(move || {
            let write_result = stdin
                .write_all(&secret_envelope)
                .map_err(|error| format!("Failed to write trading bot secret envelope: {error}"))
                .and_then(|()| {
                    stdin.flush().map_err(|error| {
                        format!("Failed to flush trading bot secret envelope: {error}")
                    })
                });
            drop(secret_envelope);
            let _ = result_tx.send(write_result.map(|()| stdin));
        })
        .map_err(|error| format!("Failed to start trading bot secret handoff: {error}"))?;
    Ok(BotSecretHandoff {
        result_rx,
        join_handle,
    })
}

fn wait_for_bot_secret_handoff(
    child: &mut Child,
    result_rx: &Receiver<Result<ChildStdin, String>>,
    stop_rx: &Receiver<()>,
    worker_lease: &BotWorkerLifecycleLease,
    timeout: Duration,
) -> BotSecretHandoffOutcome {
    let deadline = Instant::now() + timeout;
    loop {
        if bot_stop_requested(stop_rx, worker_lease) {
            return BotSecretHandoffOutcome::StoppedByRequest;
        }

        match child.try_wait() {
            Ok(Some(status)) => return BotSecretHandoffOutcome::ProcessExited(status),
            Ok(None) => {}
            Err(error) => {
                return BotSecretHandoffOutcome::Failed(format!(
                    "Failed to monitor trading bot during secret handoff: {error}"
                ));
            }
        }

        let now = Instant::now();
        if now >= deadline {
            return BotSecretHandoffOutcome::TimedOut;
        }
        let poll_interval = (deadline - now).min(PROCESS_STOP_POLL_INTERVAL);
        match result_rx.recv_timeout(poll_interval) {
            Ok(Ok(stdin)) => return BotSecretHandoffOutcome::Completed(stdin),
            Ok(Err(error)) => return BotSecretHandoffOutcome::Failed(error),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return BotSecretHandoffOutcome::Failed(
                    "Trading bot secret handoff stopped unexpectedly".to_owned(),
                );
            }
        }
    }
}

fn abort_bot_secret_handoff(child: &mut Child, handoff: BotSecretHandoff) -> Result<(), String> {
    // Killing the reader closes the pipe and guarantees the blocking writer can be joined.
    terminate_bot_during_secret_handoff(child)?;
    join_bot_secret_handoff(handoff)
}

fn terminate_bot_during_secret_handoff(child: &mut Child) -> Result<(), String> {
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) | Err(_) => {
            if let Err(kill_error) = child.kill() {
                let exited_after_race = child.try_wait().is_ok_and(|status| status.is_some());
                if !exited_after_race {
                    return Err(format!(
                        "Failed to terminate trading bot during secret handoff: {kill_error}"
                    ));
                }
            }
        }
    }
    child
        .wait()
        .map(|_| ())
        .map_err(|error| format!("Failed to reap trading bot after secret handoff: {error}"))
}

fn join_bot_secret_handoff(handoff: BotSecretHandoff) -> Result<(), String> {
    handoff
        .join_handle
        .join()
        .map_err(|_| "Trading bot secret handoff task panicked".to_owned())
}

fn join_handoff_errors(primary: String, cleanup: Option<String>) -> String {
    match cleanup {
        Some(cleanup) => format!("{primary}; cleanup failed: {cleanup}"),
        None => primary,
    }
}

enum BotStartOutcome {
    Bootstrapping(BotLifecyclePayload),
    Ready(BotLifecyclePayload),
    StoppedByRequest,
    StartupFailure(String),
    ProcessExited { status: ExitStatus },
    ProcessFailure { error: String },
}

fn wait_for_bot_start_signal(
    status_ref: &Arc<Mutex<RuntimeStatus>>,
    spec: crate::runtime::bot_runtime::BotRuntimeSpec,
    child: &mut Child,
    lifecycle_rx: &Receiver<Result<BotLifecyclePayload, String>>,
    stop_rx: &Receiver<()>,
    worker_lease: &BotWorkerLifecycleLease,
    timeout: Duration,
) -> BotStartOutcome {
    let deadline = Instant::now() + timeout;

    loop {
        if bot_stop_requested(stop_rx, worker_lease) {
            return BotStartOutcome::StoppedByRequest;
        }

        if let Some(process) = first_unhealthy_critical_dependency(status_ref, spec) {
            return BotStartOutcome::StartupFailure(format!(
                "Critical dependency became unavailable during bot startup: {process}"
            ));
        }

        match lifecycle_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(payload)) => match payload.kind() {
                Some(BotLifecycleKind::Bootstrapping)
                | Some(BotLifecycleKind::BootstrapProgress) => {
                    return BotStartOutcome::Bootstrapping(payload);
                }
                Some(BotLifecycleKind::Ready) => return BotStartOutcome::Ready(payload),
                None => {}
            },
            Ok(Err(error)) => return BotStartOutcome::StartupFailure(error),
            Err(RecvTimeoutError::Disconnected) => {
                return BotStartOutcome::StartupFailure(
                    "Trading bot lifecycle signal channel closed unexpectedly".to_owned(),
                );
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        match child.try_wait() {
            Ok(Some(status)) => return BotStartOutcome::ProcessExited { status },
            Ok(None) => {}
            Err(error) => {
                return BotStartOutcome::ProcessFailure {
                    error: error.to_string(),
                };
            }
        }

        if Instant::now() >= deadline {
            return BotStartOutcome::StartupFailure(format!(
                "Trading bot did not report bootstrapping or ready within {}s",
                timeout.as_secs()
            ));
        }
    }
}

enum BotBootstrapOutcome {
    Ready(BotLifecyclePayload),
    StoppedByRequest,
    BootstrapFailure(String),
    CriticalDependencyUnavailable { process: String },
    ProcessExited { status: ExitStatus },
    ProcessFailure { error: String },
}

fn wait_for_bot_ready_after_bootstrap_start(
    status_ref: &Arc<Mutex<RuntimeStatus>>,
    spec: crate::runtime::bot_runtime::BotRuntimeSpec,
    child: &mut Child,
    lifecycle_rx: &Receiver<Result<BotLifecyclePayload, String>>,
    stop_rx: &Receiver<()>,
    worker_lease: &BotWorkerLifecycleLease,
    stall_timeout: Duration,
) -> BotBootstrapOutcome {
    let mut last_progress_at = Instant::now();

    loop {
        if bot_stop_requested(stop_rx, worker_lease) {
            return BotBootstrapOutcome::StoppedByRequest;
        }

        match lifecycle_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(payload)) => match payload.kind() {
                Some(BotLifecycleKind::Ready) => {
                    return BotBootstrapOutcome::Ready(payload);
                }
                Some(BotLifecycleKind::Bootstrapping)
                | Some(BotLifecycleKind::BootstrapProgress) => {
                    last_progress_at = Instant::now();
                }
                None => {}
            },
            Ok(Err(error)) => return BotBootstrapOutcome::BootstrapFailure(error),
            Err(RecvTimeoutError::Disconnected) => {
                return BotBootstrapOutcome::BootstrapFailure(
                    "Trading bot lifecycle signal channel closed unexpectedly".to_owned(),
                );
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        if let Some(process) = first_unhealthy_critical_dependency(status_ref, spec) {
            return BotBootstrapOutcome::CriticalDependencyUnavailable { process };
        }

        match child.try_wait() {
            Ok(Some(status)) => return BotBootstrapOutcome::ProcessExited { status },
            Ok(None) => {}
            Err(error) => {
                return BotBootstrapOutcome::ProcessFailure {
                    error: error.to_string(),
                };
            }
        }

        if last_progress_at.elapsed() >= stall_timeout {
            return BotBootstrapOutcome::BootstrapFailure(format!(
                "Trading bot bootstrap stalled: no progress signal received within {}s",
                stall_timeout.as_secs()
            ));
        }
    }
}

enum BotMonitorOutcome {
    StoppedByRequest,
    CriticalDependencyUnavailable { process: String },
    ProcessExited { status: ExitStatus },
    ProcessFailure { error: String },
}

fn monitor_bot_process(
    status_ref: &Arc<Mutex<RuntimeStatus>>,
    spec: crate::runtime::bot_runtime::BotRuntimeSpec,
    process: &mut ManagedProcess,
    stop_rx: &Receiver<()>,
    worker_lease: &BotWorkerLifecycleLease,
) -> BotMonitorOutcome {
    loop {
        if worker_lease.is_cancelled() {
            return BotMonitorOutcome::StoppedByRequest;
        }
        match stop_rx.recv_timeout(MONITOR_POLL_INTERVAL) {
            Ok(()) => {
                return BotMonitorOutcome::StoppedByRequest;
            }
            Err(RecvTimeoutError::Disconnected) => {
                return BotMonitorOutcome::StoppedByRequest;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        if let Some(process) = first_unhealthy_critical_dependency(status_ref, spec) {
            return BotMonitorOutcome::CriticalDependencyUnavailable { process };
        }

        match process.child.try_wait() {
            Ok(Some(status)) => return BotMonitorOutcome::ProcessExited { status },
            Ok(None) => {}
            Err(error) => {
                return BotMonitorOutcome::ProcessFailure {
                    error: error.to_string(),
                };
            }
        }
    }
}

fn bot_stop_requested(stop_rx: &Receiver<()>, worker_lease: &BotWorkerLifecycleLease) -> bool {
    if worker_lease.is_cancelled() {
        return true;
    }
    match stop_rx.try_recv() {
        Ok(()) | Err(TryRecvError::Disconnected) => true,
        Err(TryRecvError::Empty) => false,
    }
}

fn first_unhealthy_critical_dependency(
    status_ref: &Arc<Mutex<RuntimeStatus>>,
    spec: crate::runtime::bot_runtime::BotRuntimeSpec,
) -> Option<String> {
    let status = status_ref.lock().ok()?;
    if status.state != "running" {
        return Some(SUPERVISOR_PROCESS_NAME.to_owned());
    }
    spec.critical_processes
        .iter()
        .find(|process| {
            !status
                .running_processes
                .iter()
                .any(|running| running == *process)
        })
        .map(|process| (*process).to_owned())
}

fn spawn_bot_stdout_worker<R>(
    app: AppHandle,
    logs_dir: std::path::PathBuf,
    process: String,
    bot_kind: BotKind,
    reader: R,
    lifecycle_tx: Sender<Result<BotLifecyclePayload, String>>,
) -> JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffered = BufReader::new(reader);
        let mut line = String::new();
        let mut lifecycle_started = false;

        loop {
            line.clear();
            let bytes = match buffered.read_line(&mut line) {
                Ok(bytes) => bytes,
                Err(error) => {
                    if !lifecycle_started {
                        let _ = lifecycle_tx
                            .send(Err(format!("Failed to read trading bot stdout: {error}")));
                        lifecycle_started = true;
                    }
                    break;
                }
            };
            if bytes == 0 {
                break;
            }
            let payload_line = line.trim_end_matches(['\r', '\n']).to_owned();
            if payload_line.is_empty() {
                continue;
            }

            if let Ok(payload) = serde_json::from_str::<BotLifecyclePayload>(&payload_line) {
                if payload.bot_kind == bot_kind && payload.kind().is_some() {
                    append_child_process_log_line(&logs_dir, &process, "lifecycle", &payload_line);
                    let _ = lifecycle_tx.send(Ok(payload));
                    lifecycle_started = true;
                    continue;
                }
            }

            let payload = RuntimeLogEvent {
                process: process.clone(),
                stream: "stdout".to_owned(),
                line: payload_line.clone(),
            };
            let _ = app.emit("runtime-log", &payload);
            append_child_process_log_line(&logs_dir, &process, "stdout", &payload_line);
        }

        if !lifecycle_started {
            let _ =
                lifecycle_tx.send(Err("Trading bot did not emit a lifecycle signal".to_owned()));
        }
    })
}

fn stop_requested(stop_rx: &Receiver<()>, stop_signal: &AtomicBool) -> bool {
    if stop_signal.load(Ordering::SeqCst) {
        return true;
    }
    match stop_rx.try_recv() {
        Ok(()) => {
            stop_signal.store(true, Ordering::SeqCst);
            true
        }
        Err(TryRecvError::Disconnected) => {
            stop_signal.store(true, Ordering::SeqCst);
            true
        }
        Err(TryRecvError::Empty) => false,
    }
}

fn spawn_runtime_processes(
    app: &AppHandle,
    config: &DesktopRuntimeConfig,
    stop_rx: &Receiver<()>,
    stop_signal: &AtomicBool,
) -> Result<Vec<ManagedProcess>, SpawnRuntimeError> {
    let mut processes = Vec::<ManagedProcess>::new();

    if stop_requested(stop_rx, stop_signal) {
        return Err(SpawnRuntimeError::Cancelled);
    }

    let nats_process = match spawn_nats_process(app, config) {
        Ok(process) => process,
        Err(error) => {
            stop_all_processes(app, &config.logs_dir, &mut processes);
            return Err(SpawnRuntimeError::Failed(error));
        }
    };
    processes.push(nats_process);
    emit_supervisor_log(
        app,
        &config.logs_dir,
        "info",
        "Waiting for NATS port binding",
    );
    if let Err(error) = wait_for_port(
        config.nats_host.as_str(),
        config.nats_port,
        STARTUP_PORT_TIMEOUT,
        "NATS",
        stop_rx,
        stop_signal,
    ) {
        stop_all_processes(app, &config.logs_dir, &mut processes);
        return Err(map_startup_wait_error(error));
    }

    let backend_process =
        match spawn_node_process(app, config, BACKEND_PROCESS_NAME, BACKEND_ARTIFACT) {
            Ok(process) => process,
            Err(error) => {
                stop_all_processes(app, &config.logs_dir, &mut processes);
                return Err(SpawnRuntimeError::Failed(error));
            }
        };
    processes.push(backend_process);
    emit_supervisor_log(
        app,
        &config.logs_dir,
        "info",
        "Waiting for backend API port binding",
    );
    if let Err(error) = wait_for_port(
        "127.0.0.1",
        config.backend_port,
        STARTUP_PORT_TIMEOUT,
        "Backend API",
        stop_rx,
        stop_signal,
    ) {
        stop_all_processes(app, &config.logs_dir, &mut processes);
        return Err(map_startup_wait_error(error));
    }

    for (name, artifact) in INDEXER_WORKERS {
        if stop_requested(stop_rx, stop_signal) {
            stop_all_processes(app, &config.logs_dir, &mut processes);
            return Err(SpawnRuntimeError::Cancelled);
        }
        if is_opensea_worker(name) && !config.capabilities.opensea.enabled {
            let reason = config
                .capabilities
                .opensea
                .reason
                .as_deref()
                .unwrap_or("OpenSea integration is disabled");
            emit_supervisor_log(
                app,
                &config.logs_dir,
                "info",
                &format!("Skipping process {name}: {reason}"),
            );
            continue;
        }
        let process = match spawn_node_process(app, config, name, artifact) {
            Ok(process) => process,
            Err(error) => {
                stop_all_processes(app, &config.logs_dir, &mut processes);
                return Err(SpawnRuntimeError::Failed(error));
            }
        };
        processes.push(process);
    }

    emit_supervisor_log(
        app,
        &config.logs_dir,
        "info",
        "Waiting for backend semantic runtime health",
    );
    if let Err(error) = wait_for_backend_runtime_health(
        config.backend_port,
        STARTUP_RUNTIME_HEALTH_TIMEOUT,
        stop_rx,
        stop_signal,
    ) {
        stop_all_processes(app, &config.logs_dir, &mut processes);
        return Err(map_startup_wait_error(error));
    }

    Ok(processes)
}

fn is_opensea_worker(process_name: &str) -> bool {
    matches!(
        process_name,
        "indexer-opensea-stream-worker"
            | "indexer-opensea-bootstrap-worker"
            | "indexer-opensea-reconcile-worker"
            | "indexer-opensea-reconcile-scheduler-worker"
    )
}

fn sleep_with_stop(stop_rx: &Receiver<()>, stop_signal: &AtomicBool, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    loop {
        if stop_requested(stop_rx, stop_signal) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        let remaining = deadline.saturating_duration_since(now);
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
}

#[derive(Debug)]
enum SpawnRuntimeError {
    Cancelled,
    Failed(String),
}

#[derive(Debug)]
enum StartupWaitError {
    Cancelled,
    Failed(String),
}

fn map_startup_wait_error(error: StartupWaitError) -> SpawnRuntimeError {
    match error {
        StartupWaitError::Cancelled => SpawnRuntimeError::Cancelled,
        StartupWaitError::Failed(message) => SpawnRuntimeError::Failed(message),
    }
}

fn spawn_nats_process(
    app: &AppHandle,
    config: &DesktopRuntimeConfig,
) -> Result<ManagedProcess, String> {
    let args = build_nats_process_args(config);
    spawn_process(
        app,
        config,
        ProcessSpec {
            name: NATS_PROCESS_NAME.to_owned(),
            command: config.nats_bin.to_string_lossy().into_owned(),
            args,
            cleanup: None,
        },
    )
}

fn build_nats_process_args(config: &DesktopRuntimeConfig) -> Vec<String> {
    vec![
        NATS_JETSTREAM_ENABLE_ARG.to_owned(),
        NATS_PORT_ARG.to_owned(),
        config.nats_port.to_string(),
        NATS_STORE_DIR_ARG.to_owned(),
        config.nats_store_dir.to_string_lossy().into_owned(),
    ]
}

fn spawn_node_process(
    app: &AppHandle,
    config: &DesktopRuntimeConfig,
    process_name: &str,
    artifact_relative_path: &str,
) -> Result<ManagedProcess, String> {
    let artifact_path = config.runtime_dir.join(artifact_relative_path);
    if !artifact_path.exists() {
        return Err(format!(
            "Runtime artifact missing for {process_name}: {}. Build runtime resources with `yarn build:runtime && yarn build:desktop-runtime-resources`.",
            artifact_path.display()
        ));
    }

    let args = build_node_process_args(
        &config.pnp_cjs_path,
        &config.pnp_loader_path,
        &artifact_path,
    );
    spawn_process(
        app,
        config,
        ProcessSpec {
            name: process_name.to_owned(),
            command: config.node_bin.to_string_lossy().into_owned(),
            args,
            cleanup: None,
        },
    )
}

struct ProcessSpec {
    name: String,
    command: String,
    args: Vec<String>,
    cleanup: Option<ProcessCleanupSpec>,
}

struct ProcessCleanupSpec {
    command: String,
    args: Vec<String>,
}

struct ManagedProcess {
    name: String,
    child: Child,
    output_threads: Vec<JoinHandle<()>>,
    cleanup: Option<ProcessCleanupSpec>,
}

fn spawn_process(
    app: &AppHandle,
    config: &DesktopRuntimeConfig,
    spec: ProcessSpec,
) -> Result<ManagedProcess, String> {
    let command_line = render_command_line(spec.command.as_str(), &spec.args);
    emit_supervisor_log(
        app,
        &config.logs_dir,
        "info",
        &format!(
            "Spawning process {} with command: {command_line}",
            spec.name
        ),
    );

    let mut command = Command::new(&spec.command);
    command
        .args(&spec.args)
        .current_dir(&config.runtime_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in &config.process_env {
        command.env(key, value);
    }

    let mut child = command.spawn().map_err(|error| {
        let message = format!(
            "Failed to spawn process {} via {} {}: {error}",
            spec.name,
            spec.command,
            spec.args.join(" ")
        );
        emit_supervisor_log(app, &config.logs_dir, "error", &message);
        message
    })?;
    emit_supervisor_log(
        app,
        &config.logs_dir,
        "info",
        &format!("Process {} started (pid={})", spec.name, child.id()),
    );

    let mut output_threads = Vec::<JoinHandle<()>>::new();
    if let Some(stdout) = child.stdout.take() {
        output_threads.push(spawn_log_stream_worker(
            app.clone(),
            config.logs_dir.clone(),
            spec.name.clone(),
            "stdout",
            stdout,
        ));
    }
    if let Some(stderr) = child.stderr.take() {
        output_threads.push(spawn_log_stream_worker(
            app.clone(),
            config.logs_dir.clone(),
            spec.name.clone(),
            "stderr",
            stderr,
        ));
    }

    Ok(ManagedProcess {
        name: spec.name,
        child,
        output_threads,
        cleanup: spec.cleanup,
    })
}

fn build_node_process_args(
    pnp_cjs_path: &std::path::Path,
    pnp_loader_path: &std::path::Path,
    artifact_path: &std::path::Path,
) -> Vec<String> {
    vec![
        "--require".to_owned(),
        pnp_cjs_path.to_string_lossy().into_owned(),
        "--experimental-loader".to_owned(),
        pnp_loader_path.to_string_lossy().into_owned(),
        artifact_path.to_string_lossy().into_owned(),
    ]
}

fn render_command_line(command: &str, args: &[String]) -> String {
    if args.is_empty() {
        return command.to_owned();
    }
    format!("{command} {}", args.join(" "))
}

fn spawn_log_stream_worker<R>(
    app: AppHandle,
    logs_dir: std::path::PathBuf,
    process: String,
    stream: &'static str,
    reader: R,
) -> JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffered = BufReader::new(reader);
        let mut line = String::new();

        loop {
            line.clear();
            let bytes = match buffered.read_line(&mut line) {
                Ok(bytes) => bytes,
                Err(_) => break,
            };
            if bytes == 0 {
                break;
            }
            let payload_line = line.trim_end_matches(['\r', '\n']).to_owned();
            if payload_line.is_empty() {
                continue;
            }
            let payload = RuntimeLogEvent {
                process: process.clone(),
                stream: stream.to_owned(),
                line: payload_line.clone(),
            };
            let _ = app.emit("runtime-log", &payload);
            append_child_process_log_line(&logs_dir, &process, stream, &payload_line);
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLogEvent {
    process: String,
    stream: String,
    line: String,
}

fn emit_supervisor_log(app: &AppHandle, logs_dir: &std::path::Path, level: &str, line: &str) {
    let payload = RuntimeLogEvent {
        process: SUPERVISOR_PROCESS_NAME.to_owned(),
        stream: level.to_owned(),
        line: line.to_owned(),
    };
    let _ = app.emit("runtime-log", &payload);
    append_desktop_supervisor_log(logs_dir, level, line);
}

enum MonitorOutcome {
    StoppedByRequest,
    ProcessExited { process: String, status: ExitStatus },
    ProcessFailure { process: String, error: String },
}

fn monitor_processes(
    processes: &mut [ManagedProcess],
    stop_rx: &Receiver<()>,
    stop_signal: &AtomicBool,
) -> MonitorOutcome {
    loop {
        match stop_rx.recv_timeout(MONITOR_POLL_INTERVAL) {
            Ok(()) => {
                stop_signal.store(true, Ordering::SeqCst);
                return MonitorOutcome::StoppedByRequest;
            }
            Err(RecvTimeoutError::Disconnected) => {
                stop_signal.store(true, Ordering::SeqCst);
                return MonitorOutcome::StoppedByRequest;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        for process in processes.iter_mut() {
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    return MonitorOutcome::ProcessExited {
                        process: process.name.clone(),
                        status,
                    };
                }
                Ok(None) => {}
                Err(error) => {
                    return MonitorOutcome::ProcessFailure {
                        process: process.name.clone(),
                        error: error.to_string(),
                    };
                }
            }
        }
    }
}

fn stop_all_processes(
    app: &AppHandle,
    logs_dir: &std::path::Path,
    processes: &mut [ManagedProcess],
) {
    let should_wait_for_exit = processes
        .iter_mut()
        .map(|process| {
            request_process_stop(app, logs_dir, process.name.as_str(), &mut process.child)
        })
        .collect::<Vec<_>>();

    for (process, should_wait) in processes.iter_mut().zip(should_wait_for_exit) {
        if !should_wait {
            continue;
        }
        wait_for_process_exit_or_kill(
            app,
            logs_dir,
            process.name.as_str(),
            &mut process.child,
            PROCESS_STOP_GRACE_PERIOD,
        );
    }
    for process in processes.iter_mut() {
        for thread in process.output_threads.drain(..) {
            let _ = thread.join();
        }
    }
    for process in processes.iter_mut() {
        if let Some(cleanup) = process.cleanup.as_ref() {
            let _ = Command::new(&cleanup.command)
                .args(&cleanup.args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

fn request_process_stop(
    app: &AppHandle,
    logs_dir: &std::path::Path,
    process_name: &str,
    child: &mut Child,
) -> bool {
    let pid = child.id();
    match child.try_wait() {
        Ok(Some(status)) => {
            emit_supervisor_log(
                app,
                logs_dir,
                SUPERVISOR_LOG_LEVEL_INFO,
                &format!(
                    "Process {process_name} already exited before shutdown signal (pid={pid}, status={status})"
                ),
            );
            return false;
        }
        Ok(None) => {}
        Err(error) => {
            emit_supervisor_log(
                app,
                logs_dir,
                SUPERVISOR_LOG_LEVEL_WARN,
                &format!(
                    "Failed to poll process {process_name} before shutdown signal: {error} (pid={pid})"
                ),
            );
        }
    }

    #[cfg(unix)]
    {
        emit_supervisor_log(
            app,
            logs_dir,
            SUPERVISOR_LOG_LEVEL_INFO,
            &format!("Sending SIGTERM to process {process_name} (pid={pid})"),
        );
        match Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(status) if status.success() => {}
            Ok(status) => emit_supervisor_log(
                app,
                logs_dir,
                SUPERVISOR_LOG_LEVEL_WARN,
                &format!(
                    "SIGTERM command for process {process_name} exited with {status} (pid={pid})"
                ),
            ),
            Err(error) => emit_supervisor_log(
                app,
                logs_dir,
                SUPERVISOR_LOG_LEVEL_WARN,
                &format!("Failed to send SIGTERM to process {process_name}: {error} (pid={pid})"),
            ),
        }
    }

    #[cfg(not(unix))]
    {
        emit_supervisor_log(
            app,
            logs_dir,
            SUPERVISOR_LOG_LEVEL_INFO,
            &format!("Sending force stop to process {process_name} (pid={pid})"),
        );
        if let Err(error) = child.kill() {
            emit_supervisor_log(
                app,
                logs_dir,
                SUPERVISOR_LOG_LEVEL_WARN,
                &format!("Failed to force stop process {process_name}: {error} (pid={pid})"),
            );
        }
    }

    true
}

fn wait_for_process_exit_or_kill(
    app: &AppHandle,
    logs_dir: &std::path::Path,
    process_name: &str,
    child: &mut Child,
    grace_period: Duration,
) {
    let pid = child.id();
    let started_at = Instant::now();
    let deadline = Instant::now() + grace_period;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                emit_supervisor_log(
                    app,
                    logs_dir,
                    SUPERVISOR_LOG_LEVEL_INFO,
                    &format!(
                        "Process {process_name} exited during graceful shutdown (pid={pid}, status={status}, elapsedMs={})",
                        started_at.elapsed().as_millis()
                    ),
                );
                return;
            }
            Ok(None) => {}
            Err(error) => {
                emit_supervisor_log(
                    app,
                    logs_dir,
                    SUPERVISOR_LOG_LEVEL_ERROR,
                    &format!(
                        "Failed to poll process {process_name} shutdown status: {error} (pid={pid})"
                    ),
                );
                return;
            }
        }

        if Instant::now() >= deadline {
            emit_supervisor_log(
                app,
                logs_dir,
                SUPERVISOR_LOG_LEVEL_WARN,
                &format!(
                    "Process {process_name} did not exit within {}s; sending force kill (pid={pid})",
                    grace_period.as_secs()
                ),
            );
            match child.kill() {
                Ok(()) => match child.wait() {
                    Ok(status) => emit_supervisor_log(
                        app,
                        logs_dir,
                        SUPERVISOR_LOG_LEVEL_WARN,
                        &format!(
                            "Process {process_name} force kill completed (pid={pid}, status={status}, elapsedMs={})",
                            started_at.elapsed().as_millis()
                        ),
                    ),
                    Err(error) => emit_supervisor_log(
                        app,
                        logs_dir,
                        SUPERVISOR_LOG_LEVEL_ERROR,
                        &format!(
                            "Force kill wait failed for process {process_name}: {error} (pid={pid})"
                        ),
                    ),
                },
                Err(error) => emit_supervisor_log(
                    app,
                    logs_dir,
                    SUPERVISOR_LOG_LEVEL_ERROR,
                    &format!("Failed to force kill process {process_name}: {error} (pid={pid})"),
                ),
            }
            return;
        }

        thread::sleep(PROCESS_STOP_POLL_INTERVAL);
    }
}

fn wait_for_port(
    host: &str,
    port: u16,
    timeout: Duration,
    label: &str,
    stop_rx: &Receiver<()>,
    stop_signal: &AtomicBool,
) -> Result<(), StartupWaitError> {
    let deadline = Instant::now() + timeout;
    let lookup = format!("{host}:{port}");

    loop {
        if stop_requested(stop_rx, stop_signal) {
            return Err(StartupWaitError::Cancelled);
        }
        let addresses = match lookup.to_socket_addrs() {
            Ok(values) => values.collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        if addresses
            .iter()
            .any(|address| TcpStream::connect_timeout(address, Duration::from_millis(200)).is_ok())
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(StartupWaitError::Failed(format!(
                "{label} did not bind {host}:{port} within {}s",
                timeout.as_secs()
            )));
        }
        thread::sleep(STARTUP_WAIT_POLL_INTERVAL);
    }
}

#[derive(Deserialize)]
struct BackendRuntimeHealthResponse {
    ok: bool,
}

fn wait_for_backend_runtime_health(
    backend_port: u16,
    timeout: Duration,
    stop_rx: &Receiver<()>,
    stop_signal: &AtomicBool,
) -> Result<(), StartupWaitError> {
    let deadline = Instant::now() + timeout;
    let mut last_probe_error: Option<String> = None;

    loop {
        if stop_requested(stop_rx, stop_signal) {
            return Err(StartupWaitError::Cancelled);
        }

        match probe_backend_runtime_health(backend_port) {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(error) => {
                last_probe_error = Some(error);
            }
        }

        if Instant::now() >= deadline {
            let suffix = last_probe_error
                .as_ref()
                .map(|error| format!(" Last probe error: {error}"))
                .unwrap_or_default();
            return Err(StartupWaitError::Failed(format!(
                "Backend runtime health endpoint did not report ok within {}s.{suffix}",
                timeout.as_secs()
            )));
        }

        thread::sleep(STARTUP_WAIT_POLL_INTERVAL);
    }
}

fn probe_backend_runtime_health(backend_port: u16) -> Result<bool, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], backend_port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))
        .map_err(|error| format!("connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| format!("set read timeout failed: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| format!("set write timeout failed: {error}"))?;

    let request = format!(
        "GET /health/runtime HTTP/1.1\r\nHost: 127.0.0.1:{backend_port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("request write failed: {error}"))?;

    let mut raw_response = String::new();
    stream
        .read_to_string(&mut raw_response)
        .map_err(|error| format!("response read failed: {error}"))?;

    let mut parts = raw_response.splitn(2, "\r\n\r\n");
    let headers = parts.next().unwrap_or_default();
    let body = parts.next().unwrap_or_default();

    let status_line = headers.lines().next().unwrap_or_default();
    if !status_line.contains(" 200 ") {
        return Ok(false);
    }

    let payload: BackendRuntimeHealthResponse = serde_json::from_str(body)
        .map_err(|error| format!("invalid runtime health response: {error}"))?;
    Ok(payload.ok)
}

fn update_status<F>(status_ref: &Arc<Mutex<RuntimeStatus>>, app: &AppHandle, update: F)
where
    F: FnOnce(&mut RuntimeStatus),
{
    if let Ok(mut status) = status_ref.lock() {
        update(&mut status);
        let snapshot = status.clone();
        let _ = app.emit("runtime-state-changed", &snapshot);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    #[cfg(unix)]
    use alloy_signer_local::PrivateKeySigner;
    use serde::Deserialize;
    #[cfg(unix)]
    use tempfile::tempdir;

    use super::*;
    #[cfg(unix)]
    use crate::runtime::bot_runtime::{SNIPING_BOT_SPEC, build_trading_secret_envelope};
    use crate::runtime::config::{
        DesktopRuntimeCapabilities, DesktopWalletConfig, NATS_STORAGE_DIR_NAME, RuntimeCapability,
    };
    #[cfg(unix)]
    use crate::runtime::resource_contract::{PNP_CJS_RELATIVE_PATH, PNP_LOADER_RELATIVE_PATH};
    #[cfg(unix)]
    use crate::wallet::domain::{WalletId, WalletPrivateKey};

    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_ENTRY_NAME: &str =
        "runtime::supervisor::tests::production_bot_parent_harness_entry";
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_MODE_ENV: &str = "ARTGOD_PRODUCTION_CONTAINMENT_TEST_MODE";
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_MODE_PARENT: &str = "parent";
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_WORKSPACE_ENV: &str =
        "ARTGOD_PRODUCTION_CONTAINMENT_TEST_WORKSPACE";
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_PID_PATH_ENV: &str =
        "ARTGOD_PRODUCTION_CONTAINMENT_TEST_PID_PATH";
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_LIFECYCLE_PATH_ENV: &str =
        "ARTGOD_PRODUCTION_CONTAINMENT_TEST_LIFECYCLE_PATH";
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_READY_PATH_ENV: &str =
        "ARTGOD_PRODUCTION_CONTAINMENT_TEST_READY_PATH";
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_WALLET_ID: &str = "11111111-1111-4111-8111-111111111111";
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_CHAIN_ID: u64 = 1;
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_NODE_COMMAND: &str = "node";
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_TEST_EXECUTABLE_PATH_ENV: &str = "PATH";
    // Unix permission bits used to match executable lookup for the test Node command.
    #[cfg(unix)]
    const UNIX_EXECUTABLE_PERMISSION_MASK: u32 = 0o111;
    #[cfg(unix)]
    const UNIX_KILL_COMMAND: &str = "kill";
    #[cfg(unix)]
    const UNIX_SIGTERM_ARG: &str = "-TERM";
    #[cfg(unix)]
    const UNIX_PROCESS_PROBE_ARG: &str = "-0";
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_START_TIMEOUT: Duration = Duration::from_secs(15);
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_EXIT_TIMEOUT: Duration = Duration::from_secs(10);
    #[cfg(unix)]
    const PRODUCTION_CONTAINMENT_POLL_INTERVAL: Duration = Duration::from_millis(50);
    // Exceeds normal pipe capacity so the fixture cannot finish before Stop arrives.
    #[cfg(unix)]
    const BLOCKED_SECRET_HANDOFF_TEST_BYTES: usize = 2 * 1024 * 1024;

    // Node startup option used to model an ambient pre-entrypoint injection attempt.
    const NODE_OPTIONS_ENV_KEY: &str = "NODE_OPTIONS";

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TradingSecretEnvelopeFixture {
        wallet_id: String,
        address: String,
        private_key_hex: String,
    }

    fn load_fixture() -> TradingSecretEnvelopeFixture {
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../trading/src/runtime/fixtures/secret-envelope-v2.json");
        let raw = fs::read_to_string(&fixture_path).expect("fixture file should load");
        serde_json::from_str(&raw).expect("fixture json should parse")
    }

    fn build_test_runtime_config() -> DesktopRuntimeConfig {
        let app_data_dir = PathBuf::from("/app-data");

        DesktopRuntimeConfig {
            env_file_path: PathBuf::from("config/.env"),
            node_bin: PathBuf::from("/runtime/node/node"),
            nats_bin: PathBuf::from("/runtime/nats/nats-server"),
            nats_store_dir: app_data_dir.join(NATS_STORAGE_DIR_NAME),
            runtime_dir: PathBuf::from("/runtime"),
            pnp_cjs_path: PathBuf::from("/runtime/.pnp.cjs"),
            pnp_loader_path: PathBuf::from("/runtime/.pnp.loader.mjs"),
            nats_host: "127.0.0.1".to_owned(),
            nats_port: 42720,
            nats_url: "nats://127.0.0.1:42720".to_owned(),
            backend_port: 42710,
            chain_id: 1,
            auto_start: true,
            restart_backoff_ms: 1000,
            process_env: HashMap::from([
                (
                    "ARTGOD_DB_PATH".to_owned(),
                    "/runtime/artgod.sqlite".to_owned(),
                ),
                ("NODE_ENV".to_owned(), "production".to_owned()),
            ]),
            http_fetch_resilience:
                crate::runtime::http_fetch_resilience::HttpFetchResilienceConfig::test_fixture(),
            logs_dir: PathBuf::from("/runtime/logs"),
            capabilities: DesktopRuntimeCapabilities {
                opensea: RuntimeCapability {
                    enabled: true,
                    mode: "auto".to_owned(),
                    reason: None,
                    missing_keys: Vec::new(),
                },
            },
            wallet: DesktopWalletConfig {
                store_dir: PathBuf::from("/runtime/wallets"),
                index_path: PathBuf::from("/runtime/wallets/index.json"),
                bot_unlock_stabilization_delay_ms: 15000,
            },
        }
    }

    fn build_test_bot_launch_config() -> BotRuntimeLaunchConfig {
        let config = build_test_runtime_config();
        let spec = crate::runtime::bot_runtime::BIDDING_BOT_SPEC;
        BotRuntimeLaunchConfig {
            spec,
            artifact_path: config.runtime_dir.join(spec.artifact_relative_path),
            node_bin: config.node_bin,
            runtime_dir: config.runtime_dir,
            pnp_cjs_path: config.pnp_cjs_path,
            pnp_loader_path: config.pnp_loader_path,
            chain_id: config.chain_id,
            process_env: config.process_env,
            logs_dir: config.logs_dir,
        }
    }

    #[test]
    fn nats_launch_uses_configured_store_root_dir() {
        let config = build_test_runtime_config();
        let args = build_nats_process_args(&config);

        assert_eq!(
            config.nats_store_dir,
            PathBuf::from("/app-data").join(NATS_STORAGE_DIR_NAME)
        );
        assert_eq!(
            args,
            vec![
                NATS_JETSTREAM_ENABLE_ARG.to_owned(),
                NATS_PORT_ARG.to_owned(),
                config.nats_port.to_string(),
                NATS_STORE_DIR_ARG.to_owned(),
                config.nats_store_dir.to_string_lossy().into_owned(),
            ]
        );
    }

    #[test]
    fn trading_bot_launch_shape_does_not_leak_wallet_material() {
        let fixture = load_fixture();
        let config = build_test_bot_launch_config();
        let args = build_trading_bot_process_args(&config);
        let command_line = render_command_line(config.node_bin.to_string_lossy().as_ref(), &args);

        assert!(command_line.contains(config.spec.artifact_relative_path));
        assert!(!command_line.contains(fixture.wallet_id.as_str()));
        assert!(!command_line.contains(fixture.address.as_str()));
        assert!(!command_line.contains(fixture.private_key_hex.as_str()));

        for value in config.process_env.values() {
            assert!(!value.contains(fixture.wallet_id.as_str()));
            assert!(!value.contains(fixture.address.as_str()));
            assert!(!value.contains(fixture.private_key_hex.as_str()));
        }
    }

    #[test]
    fn trading_bot_node_args_disable_signal_started_inspection_exactly_once() {
        let config = build_test_bot_launch_config();
        let args = build_trading_bot_process_args(&config);
        let base_args = build_node_process_args(
            &config.pnp_cjs_path,
            &config.pnp_loader_path,
            &config.artifact_path,
        );

        assert_eq!(
            args.first().map(String::as_str),
            Some(KEY_BEARING_NODE_DISABLE_SIGUSR1_ARG)
        );
        assert_eq!(
            args.iter()
                .filter(|arg| arg.as_str() == KEY_BEARING_NODE_DISABLE_SIGUSR1_ARG)
                .count(),
            1
        );
        assert_eq!(args[1..], base_args);
    }

    #[cfg(unix)]
    #[test]
    fn stop_interrupts_a_secret_handoff_blocked_by_an_unread_pipe() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("unread secret recipient starts");
        let mut parent_liveness = child.stdin.take();
        let lifecycle = BotLifecycleCoordinator::default();
        let reservation = lifecycle.reserve_start(BotKind::Sniping).unwrap();
        let worker_lease = reservation.worker_lease();
        let (stop_tx, stop_rx) = mpsc::channel();
        let stop_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            stop_tx.send(()).expect("blocked handoff stop is sent");
        });
        let started_at = Instant::now();

        let outcome = deliver_bot_secret_envelope(
            &mut child,
            &mut parent_liveness,
            &stop_rx,
            &worker_lease,
            Zeroizing::new(vec![7_u8; BLOCKED_SECRET_HANDOFF_TEST_BYTES]),
            BOT_SECRET_HANDOFF_TIMEOUT,
        );

        stop_thread.join().unwrap();
        assert!(matches!(
            outcome,
            BotSecretDeliveryOutcome::StoppedByRequest
        ));
        assert!(
            started_at.elapsed() < Duration::from_secs(5),
            "blocked secret handoff did not stop promptly"
        );
        assert!(child.try_wait().unwrap().is_some());
        assert!(parent_liveness.is_none());
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "production Node parent-containment proof is run by the desktop containment script"]
    fn production_bot_exits_gracefully_and_after_hard_parent_death() {
        let workspace_root = test_workspace_root();

        // Prove SIGTERM can complete while the desktop still retains the liveness writer.
        let mut graceful_bot = spawn_production_test_bot(&workspace_root);
        let graceful_ready = wait_for_production_bot_ready(&graceful_bot);
        assert_eq!(graceful_ready.bot_kind, BotKind::Sniping);
        send_unix_signal(graceful_bot.child.id(), UNIX_SIGTERM_ARG);
        let graceful_status =
            wait_for_child_exit(&mut graceful_bot.child, PRODUCTION_CONTAINMENT_EXIT_TIMEOUT);
        assert!(
            graceful_status.success(),
            "production bot did not exit cleanly after SIGTERM: {graceful_status}; diagnostics: {}",
            graceful_bot.diagnostics()
        );
        graceful_bot.join_output_threads();

        let temp = tempdir().expect("production containment directory is created");
        let pid_path = temp.path().join("bot.pid");
        let lifecycle_path = temp.path().join("bot.lifecycle");
        let ready_path = temp.path().join("bot.ready");
        let mut parent = spawn_production_parent_harness(
            &workspace_root,
            &pid_path,
            &lifecycle_path,
            &ready_path,
        );

        wait_for_test_file(&ready_path, PRODUCTION_CONTAINMENT_START_TIMEOUT);
        let bot_pid = read_test_pid(&pid_path);
        assert!(
            unix_process_is_alive(bot_pid),
            "production bot never became active"
        );
        let ready_payload =
            fs::read_to_string(&lifecycle_path).expect("production bot lifecycle is readable");
        assert!(
            ready_payload.contains(SNIPING_BOT_SPEC.process_name),
            "production bot readiness lifecycle was not recorded"
        );

        // Simulate an ungraceful desktop death while the real Node bot is ready.
        parent.hard_kill();

        wait_for_unix_process_exit(bot_pid, PRODUCTION_CONTAINMENT_EXIT_TIMEOUT);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "subprocess entrypoint for the production Node containment proof"]
    fn production_bot_parent_harness_entry() {
        let Ok(mode) = std::env::var(PRODUCTION_CONTAINMENT_TEST_MODE_ENV) else {
            return;
        };
        assert_eq!(mode, PRODUCTION_CONTAINMENT_TEST_MODE_PARENT);
        let workspace_root = required_test_path(PRODUCTION_CONTAINMENT_TEST_WORKSPACE_ENV);
        let pid_path = required_test_path(PRODUCTION_CONTAINMENT_TEST_PID_PATH_ENV);
        let lifecycle_path = required_test_path(PRODUCTION_CONTAINMENT_TEST_LIFECYCLE_PATH_ENV);
        let ready_path = required_test_path(PRODUCTION_CONTAINMENT_TEST_READY_PATH_ENV);
        let mut bot = spawn_production_test_bot(&workspace_root);
        let ready = wait_for_production_bot_ready(&bot);

        fs::write(&pid_path, bot.child.id().to_string()).expect("production bot pid is published");
        fs::write(
            &lifecycle_path,
            format!(
                "{} {}",
                SNIPING_BOT_SPEC.process_name,
                ready.readiness_fields()
            ),
        )
        .expect("production bot readiness lifecycle is published");
        fs::write(&ready_path, "ready").expect("production bot readiness is published");

        let _ = bot.child.wait();
        bot.join_output_threads();
    }

    #[cfg(unix)]
    struct ProductionTestBot {
        child: Child,
        _parent_liveness: Option<ChildStdin>,
        _containment: ChildProcessContainment,
        lifecycle_rx: Receiver<Result<BotLifecyclePayload, String>>,
        output_threads: Vec<JoinHandle<()>>,
        diagnostics: Arc<Mutex<String>>,
    }

    #[cfg(unix)]
    struct ProductionParentHarness {
        child: Child,
        reaped: bool,
    }

    #[cfg(unix)]
    impl ProductionParentHarness {
        fn hard_kill(&mut self) {
            self.child
                .kill()
                .expect("production parent harness is hard-killed");
            self.child
                .wait()
                .expect("production parent harness is reaped");
            self.reaped = true;
        }
    }

    #[cfg(unix)]
    impl Drop for ProductionParentHarness {
        fn drop(&mut self) {
            if self.reaped {
                return;
            }
            if self.child.try_wait().is_ok_and(|status| status.is_none()) {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
        }
    }

    #[cfg(unix)]
    impl ProductionTestBot {
        fn diagnostics(&self) -> String {
            self.diagnostics
                .lock()
                .map(|diagnostics| diagnostics.clone())
                .unwrap_or_else(|_| "diagnostics lock failed".to_owned())
        }

        fn join_output_threads(&mut self) {
            for output_thread in self.output_threads.drain(..) {
                let _ = output_thread.join();
            }
        }
    }

    #[cfg(unix)]
    impl Drop for ProductionTestBot {
        fn drop(&mut self) {
            self._parent_liveness.take();
            if self.child.try_wait().is_ok_and(|status| status.is_none()) {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
            self.join_output_threads();
        }
    }

    #[cfg(unix)]
    fn spawn_production_test_bot(workspace_root: &Path) -> ProductionTestBot {
        let config = production_test_launch_config(workspace_root);
        let args = build_trading_bot_process_args(&config);
        let ContainedTradingBotChild {
            mut child,
            mut parent_liveness,
            containment,
        } = spawn_contained_trading_bot_child(&config, &args)
            .expect("production trading bot command starts");
        let lifecycle = BotLifecycleCoordinator::default();
        let reservation = lifecycle
            .reserve_start(BotKind::Sniping)
            .expect("production test lifecycle is reserved");
        let worker_lease = reservation.worker_lease();
        let (_stop_tx, stop_rx) = mpsc::channel();
        match deliver_bot_secret_envelope(
            &mut child,
            &mut parent_liveness,
            &stop_rx,
            &worker_lease,
            Zeroizing::new(production_test_secret_envelope()),
            BOT_SECRET_HANDOFF_TIMEOUT,
        ) {
            BotSecretDeliveryOutcome::Delivered => {}
            BotSecretDeliveryOutcome::StoppedByRequest => {
                panic!("production secret handoff stopped unexpectedly")
            }
            BotSecretDeliveryOutcome::Failed(error) => {
                panic!("production secret handoff failed: {error}")
            }
        }

        let stdout = child.stdout.take().expect("production bot stdout is piped");
        let stderr = child.stderr.take().expect("production bot stderr is piped");
        let (lifecycle_tx, lifecycle_rx) = mpsc::channel();
        let diagnostics = Arc::new(Mutex::new(String::new()));
        let output_threads = vec![
            spawn_production_test_stdout_worker(stdout, lifecycle_tx),
            spawn_production_test_stderr_worker(stderr, Arc::clone(&diagnostics)),
        ];

        ProductionTestBot {
            child,
            _parent_liveness: parent_liveness,
            _containment: containment,
            lifecycle_rx,
            output_threads,
            diagnostics,
        }
    }

    #[cfg(unix)]
    fn production_test_launch_config(workspace_root: &Path) -> BotRuntimeLaunchConfig {
        let artifact_path = workspace_root.join(SNIPING_BOT_SPEC.artifact_relative_path);
        let pnp_cjs_path = workspace_root.join(PNP_CJS_RELATIVE_PATH);
        let pnp_loader_path = workspace_root.join(PNP_LOADER_RELATIVE_PATH);
        let node_bin = resolve_production_containment_test_node();
        for required_path in [&artifact_path, &pnp_cjs_path, &pnp_loader_path] {
            assert!(
                required_path.is_file(),
                "required production runtime file is missing: {}",
                required_path.display()
            );
        }
        BotRuntimeLaunchConfig {
            spec: SNIPING_BOT_SPEC,
            artifact_path,
            node_bin,
            runtime_dir: workspace_root.to_path_buf(),
            pnp_cjs_path,
            pnp_loader_path,
            chain_id: PRODUCTION_CONTAINMENT_TEST_CHAIN_ID,
            process_env: HashMap::new(),
            logs_dir: workspace_root.join("tmp"),
        }
    }

    #[cfg(unix)]
    fn resolve_production_containment_test_node() -> PathBuf {
        let search_path = std::env::var_os(PRODUCTION_CONTAINMENT_TEST_EXECUTABLE_PATH_ENV)
            .expect("production containment test requires PATH to locate Node");
        let candidate = std::env::split_paths(&search_path)
            .map(|directory| directory.join(PRODUCTION_CONTAINMENT_TEST_NODE_COMMAND))
            .find(|path| {
                fs::metadata(path).is_ok_and(|metadata| {
                    metadata.is_file()
                        && metadata.permissions().mode() & UNIX_EXECUTABLE_PERMISSION_MASK != 0
                })
            })
            .unwrap_or_else(|| {
                panic!(
                    "production containment test requires {} on PATH",
                    PRODUCTION_CONTAINMENT_TEST_NODE_COMMAND
                )
            });

        // Freeze an absolute executable path before the production spawn clears PATH.
        fs::canonicalize(&candidate).unwrap_or_else(|error| {
            panic!(
                "failed to canonicalize production containment Node {}: {error}",
                candidate.display()
            )
        })
    }

    #[cfg(unix)]
    fn production_test_secret_envelope() -> Vec<u8> {
        let mut private_key_bytes = [0_u8; 32];
        private_key_bytes[31] = 1;
        let signer = PrivateKeySigner::from_slice(&private_key_bytes)
            .expect("production test private key is valid");
        let wallet_id = WalletId::parse(PRODUCTION_CONTAINMENT_TEST_WALLET_ID)
            .expect("production test wallet id is valid");
        build_trading_secret_envelope(
            &wallet_id,
            signer.address().to_string().as_str(),
            BotKind::Sniping,
            PRODUCTION_CONTAINMENT_TEST_CHAIN_ID,
            None,
            &WalletPrivateKey::new(private_key_bytes),
        )
        .expect("production test secret envelope is valid")
    }

    #[cfg(unix)]
    fn spawn_production_test_stdout_worker(
        stdout: std::process::ChildStdout,
        lifecycle_tx: Sender<Result<BotLifecyclePayload, String>>,
    ) -> JoinHandle<()> {
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ = lifecycle_tx.send(Err(
                            "Production bot stdout closed before another lifecycle event"
                                .to_owned(),
                        ));
                        return;
                    }
                    Ok(_) => {
                        let payload = line.trim_end_matches(['\r', '\n']);
                        if let Ok(payload) = serde_json::from_str::<BotLifecyclePayload>(payload)
                            && payload.bot_kind == BotKind::Sniping
                            && payload.kind().is_some()
                        {
                            let _ = lifecycle_tx.send(Ok(payload));
                        }
                    }
                    Err(error) => {
                        let _ = lifecycle_tx.send(Err(format!(
                            "Failed to read production bot stdout: {error}"
                        )));
                        return;
                    }
                }
            }
        })
    }

    #[cfg(unix)]
    fn spawn_production_test_stderr_worker(
        stderr: std::process::ChildStderr,
        diagnostics: Arc<Mutex<String>>,
    ) -> JoinHandle<()> {
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).is_ok_and(|bytes| bytes > 0) {
                if let Ok(mut diagnostics) = diagnostics.lock() {
                    diagnostics.push_str(&line);
                }
                line.clear();
            }
        })
    }

    #[cfg(unix)]
    fn wait_for_production_bot_ready(bot: &ProductionTestBot) -> BotLifecyclePayload {
        let deadline = Instant::now() + PRODUCTION_CONTAINMENT_START_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = bot
                .lifecycle_rx
                .recv_timeout(remaining)
                .unwrap_or_else(|error| {
                    panic!(
                        "production bot did not become ready: {error}; diagnostics: {}",
                        bot.diagnostics()
                    )
                });
            let payload = event.unwrap_or_else(|error| {
                panic!(
                    "production bot lifecycle failed: {error}; diagnostics: {}",
                    bot.diagnostics()
                )
            });
            if payload.kind() == Some(BotLifecycleKind::Ready) {
                return payload;
            }
        }
    }

    #[cfg(unix)]
    fn spawn_production_parent_harness(
        workspace_root: &Path,
        pid_path: &Path,
        lifecycle_path: &Path,
        ready_path: &Path,
    ) -> ProductionParentHarness {
        let mut command = Command::new(std::env::current_exe().expect("test executable exists"));
        let child = command
            .args([
                "--ignored",
                "--exact",
                PRODUCTION_CONTAINMENT_TEST_ENTRY_NAME,
                "--nocapture",
            ])
            .env(
                PRODUCTION_CONTAINMENT_TEST_MODE_ENV,
                PRODUCTION_CONTAINMENT_TEST_MODE_PARENT,
            )
            .env(PRODUCTION_CONTAINMENT_TEST_WORKSPACE_ENV, workspace_root)
            .env(PRODUCTION_CONTAINMENT_TEST_PID_PATH_ENV, pid_path)
            .env(
                PRODUCTION_CONTAINMENT_TEST_LIFECYCLE_PATH_ENV,
                lifecycle_path,
            )
            .env(PRODUCTION_CONTAINMENT_TEST_READY_PATH_ENV, ready_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("production parent harness starts");
        ProductionParentHarness {
            child,
            reaped: false,
        }
    }

    #[cfg(unix)]
    fn test_workspace_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root exists")
            .to_path_buf()
    }

    #[cfg(unix)]
    fn required_test_path(key: &str) -> PathBuf {
        std::env::var_os(key)
            .map(PathBuf::from)
            .unwrap_or_else(|| panic!("required production containment path is missing: {key}"))
    }

    #[cfg(unix)]
    fn wait_for_test_file(path: &Path, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while !path.is_file() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            thread::sleep(PRODUCTION_CONTAINMENT_POLL_INTERVAL);
        }
    }

    #[cfg(unix)]
    fn read_test_pid(path: &Path) -> u32 {
        fs::read_to_string(path)
            .expect("production bot pid is readable")
            .trim()
            .parse()
            .expect("production bot pid is valid")
    }

    #[cfg(unix)]
    fn send_unix_signal(pid: u32, signal: &str) {
        let status = Command::new(UNIX_KILL_COMMAND)
            .args([signal, pid.to_string().as_str()])
            .status()
            .expect("Unix signal command starts");
        assert!(
            status.success(),
            "failed to send signal {signal} to production bot {pid}: {status}"
        );
    }

    #[cfg(unix)]
    fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> ExitStatus {
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait().expect("production bot exit is polled") {
                Some(status) => return status,
                None if Instant::now() < deadline => {
                    thread::sleep(PRODUCTION_CONTAINMENT_POLL_INTERVAL);
                }
                None => panic!("production bot {} did not exit", child.id()),
            }
        }
    }

    #[cfg(unix)]
    fn wait_for_unix_process_exit(pid: u32, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while unix_process_is_alive(pid) {
            assert!(
                Instant::now() < deadline,
                "production bot process {pid} survived hard parent death"
            );
            thread::sleep(PRODUCTION_CONTAINMENT_POLL_INTERVAL);
        }
    }

    #[cfg(unix)]
    fn unix_process_is_alive(pid: u32) -> bool {
        Command::new(UNIX_KILL_COMMAND)
            .args([UNIX_PROCESS_PROBE_ARG, pid.to_string().as_str()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[test]
    fn key_bearing_bot_environment_is_rebuilt_from_frozen_config() {
        let config = build_test_runtime_config();
        let mut command = Command::new(&config.node_bin);
        command.env(NODE_OPTIONS_ENV_KEY, "--require=artgod-env-injection.cjs");

        configure_key_bearing_node_environment(&mut command, &config.process_env);

        let explicit_env = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value
                        .expect("configured bot env values must be present")
                        .to_string_lossy()
                        .into_owned(),
                )
            })
            .collect::<HashMap<_, _>>();

        assert_eq!(explicit_env, config.process_env);
        assert!(!explicit_env.contains_key(NODE_OPTIONS_ENV_KEY));
    }
}
