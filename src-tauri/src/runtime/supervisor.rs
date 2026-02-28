use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::runtime::config::{DesktopRuntimeConfig, NatsMode};

const BACKEND_PROCESS_NAME: &str = "backend";
const NATS_PROCESS_NAME: &str = "nats";
const STARTUP_PORT_TIMEOUT: Duration = Duration::from_secs(30);
const MONITOR_POLL_INTERVAL: Duration = Duration::from_millis(500);

const INDEXER_WORKERS: &[(&str, &str)] = &[
    ("indexer-scheduler-worker", "dev:scheduler-worker"),
    ("indexer-sync-worker", "dev:sync-worker"),
    ("indexer-reorg-worker", "dev:reorg-worker"),
    ("indexer-domain-worker", "dev:domain-worker"),
    (
        "indexer-offchain-ingest-worker",
        "dev:offchain-ingest-worker",
    ),
    ("indexer-opensea-stream-worker", "dev:opensea-stream-worker"),
    ("indexer-bootstrap-worker", "dev:bootstrap-worker"),
    ("indexer-dead-letter-worker", "dev:dead-letter-worker"),
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

pub struct RuntimeManager {
    status: Arc<Mutex<RuntimeStatus>>,
    controller: Mutex<Option<RuntimeController>>,
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
        }
    }

    pub fn auto_start(&self, app: AppHandle) -> Result<(), String> {
        let config = DesktopRuntimeConfig::load_or_create(&app)?;
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
        let config = DesktopRuntimeConfig::load_or_create(&app)?;
        self.start_with_config(app, config)
    }

    pub fn stop(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        let controller = {
            let mut guard = self
                .controller
                .lock()
                .map_err(|_| "Failed to lock runtime controller state".to_owned())?;
            guard.take()
        };

        if let Some(controller) = controller {
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
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let app_handle = app.clone();
        let join_handle = thread::spawn(move || {
            run_supervisor_loop(app_handle, config, status_ref, stop_rx);
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
    stop_rx: Receiver<()>,
) {
    let mut restart_count: u32 = 0;

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

        let mut processes = match spawn_runtime_processes(&app, &config) {
            Ok(processes) => processes,
            Err(error) => {
                restart_count = restart_count.saturating_add(1);
                update_status(&status_ref, &app, |status| {
                    status.state = "restarting".to_owned();
                    status.restart_count = restart_count;
                    status.last_error = Some(error.clone());
                    status.running_processes.clear();
                });
                if stop_requested(&stop_rx) {
                    update_status(&status_ref, &app, |status| {
                        status.state = "stopped".to_owned();
                        status.running_processes.clear();
                    });
                    break;
                }
                thread::sleep(Duration::from_millis(config.restart_backoff_ms));
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

        match monitor_processes(&mut processes, &stop_rx) {
            MonitorOutcome::StoppedByRequest => {
                stop_all_processes(&mut processes);
                update_status(&status_ref, &app, |status| {
                    status.state = "stopped".to_owned();
                    status.running_processes.clear();
                });
                break;
            }
            MonitorOutcome::ProcessExited { process, status } => {
                let error = format!("Process {process} exited unexpectedly: {status}");
                stop_all_processes(&mut processes);
                restart_count = restart_count.saturating_add(1);
                update_status(&status_ref, &app, |status_ref| {
                    status_ref.state = "restarting".to_owned();
                    status_ref.restart_count = restart_count;
                    status_ref.last_error = Some(error);
                    status_ref.running_processes.clear();
                });
                thread::sleep(Duration::from_millis(config.restart_backoff_ms));
            }
            MonitorOutcome::ProcessFailure { process, error } => {
                let details = format!("Process {process} monitor failure: {error}");
                stop_all_processes(&mut processes);
                restart_count = restart_count.saturating_add(1);
                update_status(&status_ref, &app, |status_ref| {
                    status_ref.state = "restarting".to_owned();
                    status_ref.restart_count = restart_count;
                    status_ref.last_error = Some(details);
                    status_ref.running_processes.clear();
                });
                thread::sleep(Duration::from_millis(config.restart_backoff_ms));
            }
        }
    }
}

fn stop_requested(stop_rx: &Receiver<()>) -> bool {
    match stop_rx.recv_timeout(Duration::from_millis(1)) {
        Ok(()) => true,
        Err(RecvTimeoutError::Timeout) => false,
        Err(RecvTimeoutError::Disconnected) => true,
    }
}

fn spawn_runtime_processes(
    app: &AppHandle,
    config: &DesktopRuntimeConfig,
) -> Result<Vec<ManagedProcess>, String> {
    let mut processes = Vec::<ManagedProcess>::new();

    let nats_process = spawn_nats_process(app, config)?;
    processes.push(nats_process);
    wait_for_port(config.nats_port, STARTUP_PORT_TIMEOUT, "NATS")?;

    let backend_process =
        spawn_yarn_process(app, config, BACKEND_PROCESS_NAME, "@artgod/backend", "dev")?;
    processes.push(backend_process);
    wait_for_port(config.backend_port, STARTUP_PORT_TIMEOUT, "Backend API")?;

    for (name, script) in INDEXER_WORKERS {
        let process = spawn_yarn_process(app, config, name, "@artgod/indexer", script)?;
        processes.push(process);
    }

    Ok(processes)
}

fn spawn_nats_process(
    app: &AppHandle,
    config: &DesktopRuntimeConfig,
) -> Result<ManagedProcess, String> {
    match &config.nats_mode {
        NatsMode::Docker { docker_bin, image } => {
            let container_name = format!("artgod-desktop-nats-{}", std::process::id());
            let args = vec![
                "run".to_owned(),
                "--rm".to_owned(),
                "--pull=missing".to_owned(),
                "--name".to_owned(),
                container_name,
                "-p".to_owned(),
                format!("{}:4222", config.nats_port),
                image.clone(),
                "-js".to_owned(),
            ];
            spawn_process(
                app,
                config,
                ProcessSpec {
                    name: NATS_PROCESS_NAME.to_owned(),
                    command: docker_bin.clone(),
                    args,
                },
            )
        }
        NatsMode::Binary { binary_path } => {
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
                    command: binary_path.to_string_lossy().into_owned(),
                    args,
                },
            )
        }
    }
}

fn spawn_yarn_process(
    app: &AppHandle,
    config: &DesktopRuntimeConfig,
    process_name: &str,
    workspace: &str,
    script: &str,
) -> Result<ManagedProcess, String> {
    spawn_process(
        app,
        config,
        ProcessSpec {
            name: process_name.to_owned(),
            command: config.yarn_bin.clone(),
            args: vec![
                "workspace".to_owned(),
                workspace.to_owned(),
                "run".to_owned(),
                script.to_owned(),
            ],
        },
    )
}

struct ProcessSpec {
    name: String,
    command: String,
    args: Vec<String>,
}

struct ManagedProcess {
    name: String,
    child: Child,
    output_threads: Vec<JoinHandle<()>>,
}

fn spawn_process(
    app: &AppHandle,
    config: &DesktopRuntimeConfig,
    spec: ProcessSpec,
) -> Result<ManagedProcess, String> {
    let mut command = Command::new(&spec.command);
    command
        .args(&spec.args)
        .current_dir(&config.workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in &config.process_env {
        command.env(key, value);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Failed to spawn process {} via {} {}: {error}",
            spec.name,
            spec.command,
            spec.args.join(" ")
        )
    })?;

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
    })
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

enum MonitorOutcome {
    StoppedByRequest,
    ProcessExited { process: String, status: ExitStatus },
    ProcessFailure { process: String, error: String },
}

fn monitor_processes(processes: &mut [ManagedProcess], stop_rx: &Receiver<()>) -> MonitorOutcome {
    loop {
        match stop_rx.recv_timeout(MONITOR_POLL_INTERVAL) {
            Ok(()) => return MonitorOutcome::StoppedByRequest,
            Err(RecvTimeoutError::Disconnected) => {
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
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    for process in processes.iter_mut() {
        for thread in process.output_threads.drain(..) {
            let _ = thread.join();
        }
    }
}

fn wait_for_port(port: u16, timeout: Duration, label: &str) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "{label} did not bind 127.0.0.1:{port} within {}s",
                timeout.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(150));
    }
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
