use std::collections::HashMap;
use std::fs::OpenOptions;
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
use time::OffsetDateTime;

use crate::runtime::bot_runtime::{
    BOT_RUNTIME_SPECS, BotCriticalDependencyStatus, BotRuntimeSnapshot, BotRuntimeState,
    bot_runtime_spec,
};
use crate::runtime::config::DesktopRuntimeConfig;
use crate::wallet::domain::BotKind;

const BACKEND_PROCESS_NAME: &str = "backend";
const NATS_PROCESS_NAME: &str = "nats";
const SUPERVISOR_PROCESS_NAME: &str = "desktop-supervisor";
const STARTUP_PORT_TIMEOUT: Duration = Duration::from_secs(30);
const STARTUP_RUNTIME_HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const MONITOR_POLL_INTERVAL: Duration = Duration::from_millis(500);
const PROCESS_STOP_GRACE_PERIOD: Duration = Duration::from_secs(10);
const PROCESS_STOP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const STARTUP_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(150);
const BOT_READY_TIMEOUT: Duration = Duration::from_secs(10);

const BACKEND_ARTIFACT: &str = "backend/dist-desktop/server.mjs";
const INDEXER_WORKERS: &[(&str, &str)] = &[
    (
        "indexer-scheduler-worker",
        "indexer/dist-desktop/scheduler-worker.mjs",
    ),
    (
        "indexer-sync-worker",
        "indexer/dist-desktop/sync-worker.mjs",
    ),
    (
        "indexer-reorg-worker",
        "indexer/dist-desktop/reorg-worker.mjs",
    ),
    (
        "indexer-domain-worker",
        "indexer/dist-desktop/domain-worker.mjs",
    ),
    (
        "indexer-offchain-ingest-worker",
        "indexer/dist-desktop/offchain-ingest-worker.mjs",
    ),
    (
        "indexer-opensea-stream-worker",
        "indexer/dist-desktop/opensea-stream-worker.mjs",
    ),
    (
        "indexer-opensea-bootstrap-worker",
        "indexer/dist-desktop/opensea-bootstrap-worker.mjs",
    ),
    (
        "indexer-opensea-reconcile-worker",
        "indexer/dist-desktop/opensea-reconcile-worker.mjs",
    ),
    (
        "indexer-opensea-reconcile-scheduler-worker",
        "indexer/dist-desktop/opensea-reconcile-scheduler-worker.mjs",
    ),
    (
        "indexer-bootstrap-worker",
        "indexer/dist-desktop/bootstrap-worker.mjs",
    ),
    (
        "indexer-collection-extension-worker",
        "indexer/dist-desktop/collection-extension-worker.mjs",
    ),
    (
        "indexer-dead-letter-worker",
        "indexer/dist-desktop/dead-letter-worker.mjs",
    ),
];

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
}

pub struct RuntimeManager {
    status: Arc<Mutex<RuntimeStatus>>,
    controller: Mutex<Option<RuntimeController>>,
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
            controller: Mutex::new(None),
            core_running_since: Arc::new(Mutex::new(None)),
            bot_statuses: Arc::new(Mutex::new(HashMap::new())),
            bot_controllers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn auto_start(&self, app: AppHandle) -> Result<(), String> {
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
            statuses.insert(bot_kind, ManagedBotRuntimeStatus { state, last_error });
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

    pub fn start_bot_runtime(
        &self,
        app: AppHandle,
        bot_kind: BotKind,
        secret_envelope: Vec<u8>,
    ) -> Result<(), String> {
        {
            let controllers = self
                .bot_controllers
                .lock()
                .map_err(|_| "Failed to lock bot runtime controllers".to_owned())?;
            if controllers.contains_key(&bot_kind) {
                return Err(format!("{bot_kind:?} bot is already active."));
            }
        }

        let config = DesktopRuntimeConfig::load_or_create(&app)?;
        let spec = *bot_runtime_spec(bot_kind);
        let app_handle = app.clone();
        let status_ref = Arc::clone(&self.status);
        let bot_statuses_ref = Arc::clone(&self.bot_statuses);
        let bot_controllers_ref = Arc::clone(&self.bot_controllers);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let join_handle = thread::spawn(move || {
            run_bot_runtime_loop(
                app_handle,
                config,
                spec,
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
                stop_all_processes(&mut processes);
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
                stop_all_processes(&mut processes);
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
                stop_all_processes(&mut processes);
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
        .unwrap_or(ManagedBotRuntimeStatus {
            state: BotRuntimeState::Disabled,
            last_error: None,
        });

    BotRuntimeSnapshot {
        bot_kind: spec.bot_kind,
        process_name: spec.process_name.to_owned(),
        state: status.state,
        last_error: status.last_error,
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
    config: DesktopRuntimeConfig,
    spec: crate::runtime::bot_runtime::BotRuntimeSpec,
    status_ref: Arc<Mutex<RuntimeStatus>>,
    bot_statuses_ref: Arc<Mutex<HashMap<BotKind, ManagedBotRuntimeStatus>>>,
    stop_rx: Receiver<()>,
    secret_envelope: Vec<u8>,
) {
    let stop_signal = AtomicBool::new(false);

    let mut process = match spawn_trading_bot_process(&app, &config, spec) {
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
        stop_all_processes(std::slice::from_mut(&mut process.process));
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

    match wait_for_bot_ready_signal(
        &mut process.process.child,
        &process.ready_rx,
        &stop_rx,
        &stop_signal,
        BOT_READY_TIMEOUT,
    ) {
        BotReadyOutcome::Ready(payload) => {
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
                    "{} reported ready (wallet_id={}, address={}, chain_id={})",
                    spec.process_name, payload.wallet_id, payload.address, payload.chain_id
                ),
            );
        }
        BotReadyOutcome::StoppedByRequest => {
            stop_all_processes(std::slice::from_mut(&mut process.process));
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
        BotReadyOutcome::ReadyFailure(error) => {
            stop_all_processes(std::slice::from_mut(&mut process.process));
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
        BotReadyOutcome::ProcessExited { status } => {
            let error = format!("{} exited before readiness: {status}", spec.process_name);
            stop_all_processes(std::slice::from_mut(&mut process.process));
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
        BotReadyOutcome::ProcessFailure { error } => {
            stop_all_processes(std::slice::from_mut(&mut process.process));
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
            stop_all_processes(std::slice::from_mut(&mut process.process));
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
            stop_all_processes(std::slice::from_mut(&mut process.process));
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
            stop_all_processes(std::slice::from_mut(&mut process.process));
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
            stop_all_processes(std::slice::from_mut(&mut process.process));
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
        bot_statuses.insert(bot_kind, ManagedBotRuntimeStatus { state, last_error });
        if let Ok(core_status) = status_ref.lock()
            && let Some(snapshot) =
                build_bot_runtime_snapshot(&core_status, &bot_statuses, bot_kind)
        {
            let _ = app.emit("bot-runtime-state-changed", &snapshot);
        }
    }
}

struct SpawnedBotProcess {
    process: ManagedProcess,
    stdin: Option<ChildStdin>,
    ready_rx: Receiver<Result<BotReadyPayload, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotReadyPayload {
    event: String,
    bot_kind: BotKind,
    wallet_id: String,
    address: String,
    chain_id: u64,
}

fn spawn_trading_bot_process(
    app: &AppHandle,
    config: &DesktopRuntimeConfig,
    spec: crate::runtime::bot_runtime::BotRuntimeSpec,
) -> Result<SpawnedBotProcess, String> {
    let artifact_path = config.runtime_dir.join(spec.artifact_relative_path);
    if !artifact_path.exists() {
        return Err(format!(
            "Runtime artifact missing for {}: {}. Build runtime resources with `yarn build:runtime && yarn build:desktop-runtime-resources`.",
            spec.process_name,
            artifact_path.display()
        ));
    }

    let args = build_node_process_args(config, &artifact_path);
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
    let (ready_tx, ready_rx) = mpsc::channel::<Result<BotReadyPayload, String>>();
    let mut output_threads = vec![spawn_bot_stdout_worker(
        app.clone(),
        config.logs_dir.clone(),
        spec.process_name.to_owned(),
        spec.bot_kind,
        stdout,
        ready_tx,
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
        ready_rx,
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

enum BotReadyOutcome {
    Ready(BotReadyPayload),
    StoppedByRequest,
    ReadyFailure(String),
    ProcessExited { status: ExitStatus },
    ProcessFailure { error: String },
}

fn wait_for_bot_ready_signal(
    child: &mut Child,
    ready_rx: &Receiver<Result<BotReadyPayload, String>>,
    stop_rx: &Receiver<()>,
    stop_signal: &AtomicBool,
    timeout: Duration,
) -> BotReadyOutcome {
    let deadline = Instant::now() + timeout;

    loop {
        if stop_requested(stop_rx, stop_signal) {
            return BotReadyOutcome::StoppedByRequest;
        }

        match ready_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(payload)) => return BotReadyOutcome::Ready(payload),
            Ok(Err(error)) => return BotReadyOutcome::ReadyFailure(error),
            Err(RecvTimeoutError::Disconnected) => {
                return BotReadyOutcome::ReadyFailure(
                    "Trading bot ready signal channel closed unexpectedly".to_owned(),
                );
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        match child.try_wait() {
            Ok(Some(status)) => return BotReadyOutcome::ProcessExited { status },
            Ok(None) => {}
            Err(error) => {
                return BotReadyOutcome::ProcessFailure {
                    error: error.to_string(),
                };
            }
        }

        if Instant::now() >= deadline {
            return BotReadyOutcome::ReadyFailure(format!(
                "Trading bot did not report ready within {}s",
                timeout.as_secs()
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
    ready_tx: Sender<Result<BotReadyPayload, String>>,
) -> JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let file_path = logs_dir.join(format!("{process}.log"));
        let mut log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .ok();
        let mut buffered = BufReader::new(reader);
        let mut line = String::new();
        let mut ready_sent = false;

        loop {
            line.clear();
            let bytes = match buffered.read_line(&mut line) {
                Ok(bytes) => bytes,
                Err(error) => {
                    if !ready_sent {
                        let _ = ready_tx
                            .send(Err(format!("Failed to read trading bot stdout: {error}")));
                        ready_sent = true;
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

            if !ready_sent
                && let Ok(payload) = serde_json::from_str::<BotReadyPayload>(&payload_line)
                && payload.event == "bot_ready"
                && payload.bot_kind == bot_kind
            {
                let _ = ready_tx.send(Ok(payload));
                ready_sent = true;
                continue;
            }

            let payload = RuntimeLogEvent {
                process: process.clone(),
                stream: "stdout".to_owned(),
                line: payload_line.clone(),
            };
            let _ = app.emit("runtime-log", &payload);
            if let Some(log_file) = log_file.as_mut() {
                let _ = writeln!(log_file, "[stdout] {payload_line}");
            }
        }

        if !ready_sent {
            let _ = ready_tx.send(Err("Trading bot ready signal was not emitted".to_owned()));
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
            stop_all_processes(&mut processes);
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
        stop_all_processes(&mut processes);
        return Err(map_startup_wait_error(error));
    }

    let backend_process =
        match spawn_node_process(app, config, BACKEND_PROCESS_NAME, BACKEND_ARTIFACT) {
            Ok(process) => process,
            Err(error) => {
                stop_all_processes(&mut processes);
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
        stop_all_processes(&mut processes);
        return Err(map_startup_wait_error(error));
    }

    for (name, artifact) in INDEXER_WORKERS {
        if stop_requested(stop_rx, stop_signal) {
            stop_all_processes(&mut processes);
            return Err(SpawnRuntimeError::Cancelled);
        }
        let process = match spawn_node_process(app, config, name, artifact) {
            Ok(process) => process,
            Err(error) => {
                stop_all_processes(&mut processes);
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
        stop_all_processes(&mut processes);
        return Err(map_startup_wait_error(error));
    }

    Ok(processes)
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
    let args = vec![
        "-js".to_owned(),
        "-p".to_owned(),
        config.nats_port.to_string(),
    ];
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

    let args = build_node_process_args(config, &artifact_path);
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
    config: &DesktopRuntimeConfig,
    artifact_path: &std::path::Path,
) -> Vec<String> {
    vec![
        "--require".to_owned(),
        config.pnp_cjs_path.to_string_lossy().into_owned(),
        "--experimental-loader".to_owned(),
        config.pnp_loader_path.to_string_lossy().into_owned(),
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
        let file_path = logs_dir.join(format!("{process}.log"));
        let mut log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .ok();
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
            if let Some(log_file) = log_file.as_mut() {
                let _ = writeln!(log_file, "[{stream}] {payload_line}");
            }
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

    let file_path = logs_dir.join(format!("{SUPERVISOR_PROCESS_NAME}.log"));
    let mut log_file = match OpenOptions::new().create(true).append(true).open(file_path) {
        Ok(file) => file,
        Err(_) => return,
    };
    let _ = writeln!(log_file, "[{}] [{}] {}", rfc3339_now(), level, line);
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

fn stop_all_processes(processes: &mut [ManagedProcess]) {
    for process in processes.iter_mut() {
        request_process_stop(&mut process.child);
    }

    for process in processes.iter_mut() {
        wait_for_process_exit_or_kill(&mut process.child, PROCESS_STOP_GRACE_PERIOD);
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

fn request_process_stop(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }

    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

fn wait_for_process_exit_or_kill(child: &mut Child, grace_period: Duration) {
    let deadline = Instant::now() + grace_period;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {}
            Err(_) => return,
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
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

fn rfc3339_now() -> String {
    let now = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
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
    use crate::runtime::config::DesktopWalletConfig;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TradingSecretEnvelopeFixture {
        wallet_id: String,
        address: String,
        private_key_hex: String,
    }

    fn load_fixture() -> TradingSecretEnvelopeFixture {
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../trading/src/runtime/fixtures/secret-envelope-v1.json");
        let raw = fs::read_to_string(&fixture_path).expect("fixture file should load");
        serde_json::from_str(&raw).expect("fixture json should parse")
    }

    fn build_test_runtime_config() -> DesktopRuntimeConfig {
        DesktopRuntimeConfig {
            env_file_path: PathBuf::from("config/.env"),
            node_bin: PathBuf::from("/runtime/node/node"),
            nats_bin: PathBuf::from("/runtime/nats/nats-server"),
            runtime_dir: PathBuf::from("/runtime"),
            pnp_cjs_path: PathBuf::from("/runtime/.pnp.cjs"),
            pnp_loader_path: PathBuf::from("/runtime/.pnp.loader.mjs"),
            nats_host: "127.0.0.1".to_owned(),
            nats_port: 4222,
            nats_url: "nats://127.0.0.1:4222".to_owned(),
            backend_port: 3000,
            chain_id: 1,
            auto_start: true,
            restart_backoff_ms: 1000,
            process_env: HashMap::from([
                ("ARTGOD_DB_PATH".to_owned(), "/runtime/artgod.sqlite".to_owned()),
                ("NODE_ENV".to_owned(), "production".to_owned()),
            ]),
            logs_dir: PathBuf::from("/runtime/logs"),
            wallet: DesktopWalletConfig {
                store_dir: PathBuf::from("/runtime/wallets"),
                index_path: PathBuf::from("/runtime/wallets/index.json"),
                bot_unlock_stabilization_delay_ms: 15000,
            },
        }
    }

    #[test]
    fn trading_bot_launch_shape_does_not_leak_wallet_material() {
        let fixture = load_fixture();
        let config = build_test_runtime_config();
        let spec = crate::runtime::bot_runtime::BIDDING_BOT_SPEC;
        let artifact_path = config.runtime_dir.join(spec.artifact_relative_path);
        let args = build_node_process_args(&config, &artifact_path);
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
