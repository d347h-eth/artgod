use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::app_config::load_app_config_state;
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
    stop_tx: Sender<()>,
    join_handle: JoinHandle<()>,
}

#[derive(Clone)]
struct ManagedBotRuntimeStatus {
    state: BotRuntimeState,
    last_error: Option<String>,
    bidding_mandate: Option<BiddingMandate>,
}

#[derive(Clone)]
pub struct RuntimeManager {
    status: Arc<Mutex<RuntimeStatus>>,
    controller: Arc<Mutex<Option<RuntimeController>>>,
    lifecycle_gate: Arc<Mutex<()>>,
    core_running_since: Arc<Mutex<Option<Instant>>>,
    bot_statuses: Arc<Mutex<HashMap<BotKind, ManagedBotRuntimeStatus>>>,
    bot_controllers: Arc<Mutex<HashMap<BotKind, BotRuntimeController>>>,
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
        self.stop_all_bots(&app);

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
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let app_handle = app.clone();
        let join_handle = thread::spawn(move || {
            run_supervisor_loop(
                app_handle,
                config,
                status_ref,
                core_running_since_ref,
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
            }
        }
        self.emit_bot_runtime_state_changed(app, bot_kind)
    }

    /// Atomically reserves one bot start before asynchronous native authorization work begins.
    pub fn begin_bot_unlock(&self, app: &AppHandle, bot_kind: BotKind) -> Result<(), String> {
        {
            let mut statuses = self
                .bot_statuses
                .lock()
                .map_err(|_| "Failed to lock bot runtime status".to_owned())?;
            let status = statuses
                .entry(bot_kind)
                .or_insert_with(default_managed_bot_runtime_status);
            if bot_runtime_state_is_active(status.state) {
                return Err("Bot is already active.".to_owned());
            }
            status.state = BotRuntimeState::AwaitingUnlock;
            status.last_error = None;
            status.bidding_mandate = None;
        }
        self.emit_bot_runtime_state_changed(app, bot_kind)
    }

    /// Records the native authority that will be handed to one bidding process.
    pub fn set_bot_bidding_mandate(
        &self,
        app: &AppHandle,
        bot_kind: BotKind,
        bidding_mandate: Option<BiddingMandate>,
    ) -> Result<(), String> {
        if bot_kind != BotKind::Bidding && bidding_mandate.is_some() {
            return Err("Only the bidding bot may hold a bidding mandate.".to_owned());
        }
        {
            let mut statuses = self
                .bot_statuses
                .lock()
                .map_err(|_| "Failed to lock bot runtime status".to_owned())?;
            let status = statuses
                .entry(bot_kind)
                .or_insert_with(default_managed_bot_runtime_status);
            status.bidding_mandate = bidding_mandate;
        }
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
        bot_kind: BotKind,
        stabilization_delay_ms: u64,
    ) -> Result<(), String> {
        let spec = bot_runtime_spec(bot_kind);
        loop {
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
                        "Critical dependency is unavailable for {:?}: {process}",
                        bot_kind
                    ));
                }
            }

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

    pub(crate) fn start_bot_runtime(
        &self,
        app: AppHandle,
        launch_config: BotRuntimeLaunchConfig,
        secret_envelope: Vec<u8>,
    ) -> Result<(), String> {
        let bot_kind = launch_config.spec.bot_kind;
        {
            let controllers = self
                .bot_controllers
                .lock()
                .map_err(|_| "Failed to lock bot runtime controllers".to_owned())?;
            if controllers.contains_key(&bot_kind) {
                return Err(format!("{bot_kind:?} bot is already active."));
            }
        }

        let spec = launch_config.spec;
        let app_handle = app.clone();
        let status_ref = Arc::clone(&self.status);
        let bot_statuses_ref = Arc::clone(&self.bot_statuses);
        let bot_controllers_ref = Arc::clone(&self.bot_controllers);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let join_handle = thread::spawn(move || {
            run_bot_runtime_loop(
                app_handle,
                launch_config,
                status_ref,
                bot_statuses_ref,
                stop_rx,
                secret_envelope,
            );
            if let Ok(mut controllers) = bot_controllers_ref.lock() {
                controllers.remove(&spec.bot_kind);
            }
        });

        {
            let mut controllers = self
                .bot_controllers
                .lock()
                .map_err(|_| "Failed to lock bot runtime controllers".to_owned())?;
            controllers.insert(
                bot_kind,
                BotRuntimeController {
                    stop_tx,
                    join_handle,
                },
            );
        }

        Ok(())
    }

    pub fn stop_bot_runtime(&self, app: &AppHandle, bot_kind: BotKind) -> Result<(), String> {
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
            self.set_bot_runtime_state(app, bot_kind, BotRuntimeState::Stopped, None)?;
        }

        Ok(())
    }

    fn stop_all_bots(&self, app: &AppHandle) {
        let bot_kinds = {
            let controllers = match self.bot_controllers.lock() {
                Ok(controllers) => controllers,
                Err(_) => return,
            };
            controllers.keys().copied().collect::<Vec<_>>()
        };
        for bot_kind in bot_kinds {
            let _ = self.stop_bot_runtime(app, bot_kind);
        }
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

        match monitor_processes(&mut processes, &stop_rx, &stop_signal) {
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
    stop_rx: Receiver<()>,
    secret_envelope: Vec<u8>,
) {
    let stop_signal = AtomicBool::new(false);
    let spec = config.spec;

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

    if let Err(error) = send_bot_secret_envelope(&mut process.stdin, secret_envelope) {
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

    match wait_for_bot_start_signal(
        &mut process.process.child,
        &process.lifecycle_rx,
        &stop_rx,
        &stop_signal,
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
                &stop_signal,
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
        &stop_signal,
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
    bot_statuses_ref: &Arc<Mutex<HashMap<BotKind, ManagedBotRuntimeStatus>>>,
    bot_kind: BotKind,
    state: BotRuntimeState,
    last_error: Option<String>,
) {
    if let Ok(mut bot_statuses) = bot_statuses_ref.lock() {
        let status = bot_statuses
            .entry(bot_kind)
            .or_insert_with(default_managed_bot_runtime_status);
        status.state = state;
        status.last_error = last_error;
        if !bot_runtime_state_is_active(state) {
            status.bidding_mandate = None;
        }
        if let Ok(core_status) = status_ref.lock()
            && let Some(snapshot) =
                build_bot_runtime_snapshot(&core_status, &bot_statuses, bot_kind)
        {
            let _ = app.emit("bot-runtime-state-changed", &snapshot);
        }
    }
}

fn default_managed_bot_runtime_status() -> ManagedBotRuntimeStatus {
    ManagedBotRuntimeStatus {
        state: BotRuntimeState::Disabled,
        last_error: None,
        bidding_mandate: None,
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
    lifecycle_rx: Receiver<Result<BotLifecyclePayload, String>>,
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

    let args = build_node_process_args(
        &config.pnp_cjs_path,
        &config.pnp_loader_path,
        &config.artifact_path,
    );
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

    let mut command = Command::new(&config.node_bin);
    command
        .args(&args)
        .current_dir(&config.runtime_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in &config.process_env {
        command.env(key, value);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Failed to spawn process {} via {} {}: {error}",
            spec.process_name,
            config.node_bin.display(),
            args.join(" ")
        )
    })?;
    emit_supervisor_log(
        app,
        &config.logs_dir,
        "info",
        &format!("Process {} started (pid={})", spec.process_name, child.id()),
    );

    let stdin = child.stdin.take();
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
        stdin,
        lifecycle_rx,
    })
}

fn send_bot_secret_envelope(
    stdin: &mut Option<ChildStdin>,
    secret_envelope: Vec<u8>,
) -> Result<(), String> {
    let Some(mut stdin) = stdin.take() else {
        return Err("Trading bot stdin pipe is unavailable".to_owned());
    };
    let mut secret_envelope = secret_envelope;
    let write_result = stdin
        .write_all(&secret_envelope)
        .map_err(|error| format!("Failed to write trading bot secret envelope: {error}"))
        .and_then(|()| {
            stdin
                .flush()
                .map_err(|error| format!("Failed to flush trading bot secret envelope: {error}"))
        });
    secret_envelope.fill(0);
    write_result
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
    child: &mut Child,
    lifecycle_rx: &Receiver<Result<BotLifecyclePayload, String>>,
    stop_rx: &Receiver<()>,
    stop_signal: &AtomicBool,
    timeout: Duration,
) -> BotStartOutcome {
    let deadline = Instant::now() + timeout;

    loop {
        if stop_requested(stop_rx, stop_signal) {
            return BotStartOutcome::StoppedByRequest;
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
    stop_signal: &AtomicBool,
    stall_timeout: Duration,
) -> BotBootstrapOutcome {
    let mut last_progress_at = Instant::now();

    loop {
        if stop_requested(stop_rx, stop_signal) {
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
    stop_signal: &AtomicBool,
) -> BotMonitorOutcome {
    loop {
        match stop_rx.recv_timeout(MONITOR_POLL_INTERVAL) {
            Ok(()) => {
                stop_signal.store(true, Ordering::SeqCst);
                return BotMonitorOutcome::StoppedByRequest;
            }
            Err(RecvTimeoutError::Disconnected) => {
                stop_signal.store(true, Ordering::SeqCst);
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

fn first_unhealthy_critical_dependency(
    status_ref: &Arc<Mutex<RuntimeStatus>>,
    spec: crate::runtime::bot_runtime::BotRuntimeSpec,
) -> Option<String> {
    let status = status_ref.lock().ok()?;
    if status.state != "running" {
        return spec
            .critical_processes
            .first()
            .map(|process| (*process).to_owned());
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
    use std::path::{Path, PathBuf};

    use serde::Deserialize;

    use super::*;
    use crate::runtime::config::{
        DesktopRuntimeCapabilities, DesktopWalletConfig, NATS_STORAGE_DIR_NAME, RuntimeCapability,
    };

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
        let config = build_test_runtime_config();
        let spec = crate::runtime::bot_runtime::BIDDING_BOT_SPEC;
        let artifact_path = config.runtime_dir.join(spec.artifact_relative_path);
        let args = build_node_process_args(
            &config.pnp_cjs_path,
            &config.pnp_loader_path,
            &artifact_path,
        );
        let command_line = render_command_line(config.node_bin.to_string_lossy().as_ref(), &args);

        assert!(command_line.contains(spec.artifact_relative_path));
        assert!(!command_line.contains(fixture.wallet_id.as_str()));
        assert!(!command_line.contains(fixture.address.as_str()));
        assert!(!command_line.contains(fixture.private_key_hex.as_str()));

        for value in config.process_env.values() {
            assert!(!value.contains(fixture.wallet_id.as_str()));
            assert!(!value.contains(fixture.address.as_str()));
            assert!(!value.contains(fixture.private_key_hex.as_str()));
        }
    }
}
