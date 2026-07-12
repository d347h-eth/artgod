use std::future::Future;
use std::io::{Read, Write};
use std::pin::Pin;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::task::{Context, Poll};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use artgod_secret_prompt_protocol::{
    ExportConfirmSecretPromptRequest, ExportRevealAcknowledgedResponse,
    ExportRevealSecretPromptRequest, ImportSecretPromptRequest, RemoveConfirmSecretPromptRequest,
    SECRET_PROMPT_MAX_REQUEST_BYTES, SECRET_PROMPT_MAX_RESPONSE_BYTES, SecretPromptAction,
    SecretPromptErrorCode, SecretPromptRequest, SecretPromptResponse, UnlockBiddingMandateSummary,
    UnlockSecretPromptRequest,
};
use artgod_sensitive_process::{ChildProcessContainment, prepare_process_containment};
use futures_util::future::{Either, select};
use futures_util::pin_mut;
use futures_util::task::AtomicWaker;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const SECRET_PROMPT_SIDECAR_NAME: &str = "artgod-secret-prompt";
const SECRET_PROMPT_MAX_STDERR_BYTES: usize = 4 * 1024;
const SECRET_PROMPT_IO_CHUNK_BYTES: usize = 1024;
const SECRET_PROMPT_PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const SECRET_PROMPT_LIFECYCLE_THREAD_NAME: &str = "secret-prompt-lifecycle";
const SECRET_PROMPT_WRITER_THREAD_NAME: &str = "secret-prompt-writer";
const SECRET_PROMPT_STDOUT_STREAM_NAME: &str = "stdout";
const SECRET_PROMPT_STDERR_STREAM_NAME: &str = "stderr";
const SECRET_PROMPT_OUTPUT_STREAM_NAME: &str = "output";
// A native prompt is bounded without making normal operator review time-sensitive.
const SECRET_PROMPT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Launches and owns the bundled native secret prompt helper.
#[derive(Clone, Debug)]
pub struct SecretPromptSidecar {
    sidecar_name: String,
    coordinator: Arc<SecretPromptCoordinator>,
}

#[derive(Debug, Default)]
struct SecretPromptCoordinator {
    state: Mutex<SecretPromptCoordinatorState>,
    inactive: Condvar,
}

#[derive(Debug, Default)]
struct SecretPromptCoordinatorState {
    active: Option<ActiveSecretPrompt>,
    admission_closed: bool,
}

#[derive(Clone, Debug)]
struct ActiveSecretPrompt {
    action: SecretPromptAction,
    cancellation: Arc<PromptCancellation>,
}

struct SecretPromptLease {
    coordinator: Arc<SecretPromptCoordinator>,
    action: SecretPromptAction,
}

#[derive(Debug, Default)]
struct PromptCancellation {
    cancelled: AtomicBool,
}

/// Cancellation port supplied by the bot lifecycle owner for an unlock request.
pub(crate) trait SecretPromptCancellation: Send + Sync {
    fn is_cancelled(&self) -> bool;

    fn cancelled(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

impl Default for SecretPromptSidecar {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretPromptSidecar {
    /// Creates a sidecar adapter using the canonical bundled helper name.
    pub fn new() -> Self {
        Self {
            sidecar_name: SECRET_PROMPT_SIDECAR_NAME.to_owned(),
            coordinator: Arc::new(SecretPromptCoordinator::default()),
        }
    }

    /// Closes prompt admission and waits until active process cleanup finishes.
    pub(crate) fn shutdown_and_wait(&self) -> Result<(), SecretPromptError> {
        self.coordinator.shutdown_and_wait()
    }

    /// Prompts natively for wallet import inputs.
    pub async fn request_import(
        &self,
        app: &AppHandle,
        wallet_label_hint: Option<String>,
        passphrase_min_length: usize,
    ) -> Result<ImportPromptOutput, SecretPromptError> {
        let response = self
            .run_prompt(
                app,
                SecretPromptRequest::Import(ImportSecretPromptRequest {
                    wallet_label_hint,
                    passphrase_min_length,
                }),
                None,
            )
            .await?;
        match response {
            SecretPromptResponse::ImportSubmitted(payload) => Ok(ImportPromptOutput {
                label: payload.label,
                private_key: payload.private_key,
                passphrase: payload.passphrase,
                passphrase_confirmation: payload.passphrase_confirmation,
            }),
            other => Err(SecretPromptError::UnexpectedResponse {
                expected: SecretPromptAction::Import,
                received: other.action(),
            }),
        }
    }

    /// Prompts natively for a wallet unlock passphrase.
    pub async fn request_unlock(
        &self,
        app: &AppHandle,
        wallet_label: String,
        wallet_address: String,
        reason: String,
        bidding_mandate: Option<UnlockBiddingMandateSummary>,
        cancellation: &dyn SecretPromptCancellation,
    ) -> Result<UnlockPromptOutput, SecretPromptError> {
        let response = self
            .run_prompt(
                app,
                SecretPromptRequest::Unlock(UnlockSecretPromptRequest {
                    wallet_label,
                    wallet_address,
                    reason,
                    bidding_mandate,
                }),
                Some(cancellation),
            )
            .await?;
        match response {
            SecretPromptResponse::UnlockSubmitted(payload) => Ok(UnlockPromptOutput {
                passphrase: payload.passphrase,
            }),
            other => Err(SecretPromptError::UnexpectedResponse {
                expected: SecretPromptAction::Unlock,
                received: other.action(),
            }),
        }
    }

    /// Prompts natively for wallet remove confirmation plus passphrase.
    pub async fn request_remove_confirmation(
        &self,
        app: &AppHandle,
        wallet_label: String,
        wallet_address: String,
        expected_confirmation: String,
    ) -> Result<RemoveConfirmPromptOutput, SecretPromptError> {
        let response = self
            .run_prompt(
                app,
                SecretPromptRequest::RemoveConfirm(RemoveConfirmSecretPromptRequest {
                    wallet_label,
                    wallet_address,
                    expected_confirmation,
                }),
                None,
            )
            .await?;
        match response {
            SecretPromptResponse::RemoveConfirmSubmitted(payload) => {
                Ok(RemoveConfirmPromptOutput {
                    passphrase: payload.passphrase,
                    typed_confirmation: payload.typed_confirmation,
                })
            }
            other => Err(SecretPromptError::UnexpectedResponse {
                expected: SecretPromptAction::RemoveConfirm,
                received: other.action(),
            }),
        }
    }

    /// Prompts natively for wallet export confirmation plus passphrase.
    pub async fn request_export_confirmation(
        &self,
        app: &AppHandle,
        wallet_label: String,
        wallet_address: String,
        expected_confirmation: String,
    ) -> Result<ExportConfirmPromptOutput, SecretPromptError> {
        let response = self
            .run_prompt(
                app,
                SecretPromptRequest::ExportConfirm(ExportConfirmSecretPromptRequest {
                    wallet_label,
                    wallet_address,
                    expected_confirmation,
                }),
                None,
            )
            .await?;
        match response {
            SecretPromptResponse::ExportConfirmSubmitted(payload) => {
                Ok(ExportConfirmPromptOutput {
                    passphrase: payload.passphrase,
                    typed_confirmation: payload.typed_confirmation,
                })
            }
            other => Err(SecretPromptError::UnexpectedResponse {
                expected: SecretPromptAction::ExportConfirm,
                received: other.action(),
            }),
        }
    }

    /// Reveals the plaintext private key in the helper's native window exactly once.
    pub async fn reveal_exported_private_key(
        &self,
        app: &AppHandle,
        input: ExportRevealPromptInput,
    ) -> Result<ExportRevealAcknowledgedResponse, SecretPromptError> {
        let response = self
            .run_prompt(
                app,
                SecretPromptRequest::ExportReveal(ExportRevealSecretPromptRequest {
                    wallet_label: input.wallet_label,
                    wallet_address: input.wallet_address,
                    private_key: input.private_key,
                }),
                None,
            )
            .await?;
        match response {
            SecretPromptResponse::ExportRevealAcknowledged(payload) => Ok(payload),
            other => Err(SecretPromptError::UnexpectedResponse {
                expected: SecretPromptAction::ExportReveal,
                received: other.action(),
            }),
        }
    }

    async fn run_prompt(
        &self,
        app: &AppHandle,
        request: SecretPromptRequest,
        lifecycle_cancellation: Option<&dyn SecretPromptCancellation>,
    ) -> Result<SecretPromptResponse, SecretPromptError> {
        let request_action = request.action();
        let (lease, cancellation) = self.coordinator.reserve(request_action)?;
        if lifecycle_cancellation.is_some_and(SecretPromptCancellation::is_cancelled) {
            return Err(SecretPromptError::LifecycleCancelled {
                action: request_action,
            });
        }

        let mut request_payload =
            Zeroizing::new(serde_json::to_vec(&request).map_err(|error| {
                SecretPromptError::ProtocolFailure {
                    message: format!("Failed to serialize secret prompt request: {error}"),
                }
            })?);
        if request_payload.len() > SECRET_PROMPT_MAX_REQUEST_BYTES {
            return Err(SecretPromptError::ProtocolFailure {
                message: format!(
                    "Secret prompt request exceeded {} bytes",
                    SECRET_PROMPT_MAX_REQUEST_BYTES
                ),
            });
        }
        request_payload.push(b'\n');

        // Ask Tauri to resolve the canonical bundled helper, then take direct process ownership.
        let sidecar_command = app
            .shell()
            .sidecar(&self.sidecar_name)
            .map_err(|error| SecretPromptError::SpawnFailure {
                action: request_action,
                message: error.to_string(),
            })?
            .args(["--action", request_action.as_cli_arg()]);
        let mut command: Command = sidecar_command.into();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut session = PromptSession::spawn(
            command,
            request_payload,
            request_action,
            lease,
            cancellation,
            SECRET_PROMPT_RESPONSE_TIMEOUT,
        )?;

        if let Some(lifecycle_cancellation) = lifecycle_cancellation {
            let wait_result = {
                let cancellation_future = lifecycle_cancellation.cancelled();
                pin_mut!(cancellation_future);
                match select(&mut session, cancellation_future).await {
                    Either::Left((result, _)) => Ok(result),
                    Either::Right(((), _)) => Err(()),
                }
            };
            match wait_result {
                Ok(result) => result,
                Err(()) => {
                    session.cancel();
                    let _ = (&mut session).await;
                    Err(SecretPromptError::LifecycleCancelled {
                        action: request_action,
                    })
                }
            }
        } else {
            (&mut session).await
        }
    }
}

impl SecretPromptCoordinator {
    fn reserve(
        self: &Arc<Self>,
        action: SecretPromptAction,
    ) -> Result<(SecretPromptLease, Arc<PromptCancellation>), SecretPromptError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| SecretPromptError::CoordinatorFailure)?;
        if state.admission_closed {
            return Err(SecretPromptError::LifecycleCancelled { action });
        }
        if let Some(active) = state.active.as_ref() {
            return Err(SecretPromptError::Busy {
                active: active.action,
                requested: action,
            });
        }
        let cancellation = Arc::new(PromptCancellation::default());
        state.active = Some(ActiveSecretPrompt {
            action,
            cancellation: Arc::clone(&cancellation),
        });
        Ok((
            SecretPromptLease {
                coordinator: Arc::clone(self),
                action,
            },
            cancellation,
        ))
    }

    fn shutdown_and_wait(&self) -> Result<(), SecretPromptError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| SecretPromptError::CoordinatorFailure)?;
        // Close admission atomically with cancellation so no replacement prompt can slip in.
        state.admission_closed = true;
        if let Some(prompt) = state.active.as_ref() {
            prompt.cancellation.cancel();
        }
        while state.active.is_some() {
            state = self
                .inactive
                .wait(state)
                .map_err(|_| SecretPromptError::CoordinatorFailure)?;
        }
        Ok(())
    }
}

impl Drop for SecretPromptLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.coordinator.state.lock()
            && state.active.as_ref().map(|prompt| prompt.action) == Some(self.action)
        {
            state.active = None;
            self.coordinator.inactive.notify_all();
        }
    }
}

impl PromptCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

struct PromptSession {
    cancellation: Arc<PromptCancellation>,
    completion: Arc<PromptSessionCompletion>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct PromptSessionCompletion {
    result: Mutex<Option<Result<SecretPromptResponse, SecretPromptError>>>,
    waker: AtomicWaker,
}

impl PromptSession {
    fn spawn(
        command: Command,
        request_payload: Zeroizing<Vec<u8>>,
        action: SecretPromptAction,
        lease: SecretPromptLease,
        cancellation: Arc<PromptCancellation>,
        timeout: Duration,
    ) -> Result<Self, SecretPromptError> {
        let completion = Arc::new(PromptSessionCompletion::default());
        let worker_completion = Arc::clone(&completion);
        let worker_cancellation = Arc::clone(&cancellation);
        let worker = thread::Builder::new()
            .name(SECRET_PROMPT_LIFECYCLE_THREAD_NAME.to_owned())
            .spawn(move || {
                let result = run_prompt_process(
                    command,
                    request_payload,
                    action,
                    &worker_cancellation,
                    timeout,
                );
                // Keep the global action lease until process and I/O cleanup has completed.
                drop(lease);
                worker_completion.complete(result);
            })
            .map_err(|error| SecretPromptError::SpawnFailure {
                action,
                message: format!("Failed to start secret prompt owner task: {error}"),
            })?;
        Ok(Self {
            cancellation,
            completion,
            worker: Some(worker),
        })
    }

    fn cancel(&self) {
        self.cancellation.cancel();
    }

    fn join_worker(&mut self) {
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Future for PromptSession {
    type Output = Result<SecretPromptResponse, SecretPromptError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        if let Some(result) = self.completion.take_result() {
            self.join_worker();
            return Poll::Ready(result);
        }
        self.completion.waker.register(context.waker());
        if let Some(result) = self.completion.take_result() {
            self.join_worker();
            Poll::Ready(result)
        } else {
            Poll::Pending
        }
    }
}

impl Drop for PromptSession {
    fn drop(&mut self) {
        // Future/task drop is a synchronous cleanup boundary, not a detached child.
        self.cancel();
        self.join_worker();
    }
}

impl PromptSessionCompletion {
    fn complete(&self, result: Result<SecretPromptResponse, SecretPromptError>) {
        if let Ok(mut slot) = self.result.lock() {
            *slot = Some(result);
        }
        self.waker.wake();
    }

    fn take_result(&self) -> Option<Result<SecretPromptResponse, SecretPromptError>> {
        self.result.lock().ok()?.take()
    }
}

fn run_prompt_process(
    mut command: Command,
    request_payload: Zeroizing<Vec<u8>>,
    action: SecretPromptAction,
    cancellation: &PromptCancellation,
    timeout: Duration,
) -> Result<SecretPromptResponse, SecretPromptError> {
    if cancellation.is_cancelled() {
        return Err(SecretPromptError::LifecycleCancelled { action });
    }
    let prepared = prepare_process_containment(&mut command).map_err(|error| {
        SecretPromptError::ContainmentFailure {
            action,
            message: error.to_string(),
        }
    })?;
    let mut child = command
        .spawn()
        .map_err(|error| SecretPromptError::SpawnFailure {
            action,
            message: error.to_string(),
        })?;
    let containment = match prepared.attach(&mut child) {
        Ok(containment) => containment,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SecretPromptError::ContainmentFailure {
                action,
                message: error.to_string(),
            });
        }
    };
    if cancellation.is_cancelled() {
        terminate_unowned_child(&mut child);
        return Err(SecretPromptError::LifecycleCancelled { action });
    }
    let mut process = PromptProcess::start(child, containment, request_payload, action)?;
    let deadline = Instant::now() + timeout;

    let status = loop {
        if cancellation.is_cancelled() {
            return Err(SecretPromptError::LifecycleCancelled { action });
        }
        process.poll_io()?;
        if let Some(status) = process.try_wait(action)? {
            break status;
        }
        if Instant::now() >= deadline {
            return Err(SecretPromptError::Timeout { action });
        }
        thread::sleep(SECRET_PROMPT_PROCESS_POLL_INTERVAL);
    };

    let exited_successfully = status.success();
    let PromptProcessOutput { stdout, mut stderr } = process.finish(status, action)?;
    let response = parse_prompt_response(&stdout, action)?;
    stderr.zeroize();

    if let SecretPromptResponse::Cancelled(response) = &response {
        return Err(SecretPromptError::Cancelled {
            action: response.action,
        });
    }
    if let SecretPromptResponse::Error(response) = &response {
        return Err(SecretPromptError::HelperFailure {
            action: response.action,
            code: response.code,
            message: response.message.clone(),
        });
    }
    if response.action() != action {
        return Err(SecretPromptError::UnexpectedResponse {
            expected: action,
            received: response.action(),
        });
    }
    if !exited_successfully {
        return Err(SecretPromptError::HelperFailure {
            action,
            code: SecretPromptErrorCode::InternalFailure,
            message: "Secret prompt helper exited unsuccessfully".to_owned(),
        });
    }
    Ok(response)
}

struct PromptProcess {
    child: Option<Child>,
    containment: Option<ChildProcessContainment>,
    retained_stdin: Option<ChildStdin>,
    writer: PromptWriterTask,
    stdout: PromptReaderTask,
    stderr: PromptReaderTask,
    reaped: bool,
}

struct PromptProcessOutput {
    stdout: Zeroizing<Vec<u8>>,
    stderr: Zeroizing<Vec<u8>>,
}

impl PromptProcess {
    fn start(
        mut child: Child,
        containment: ChildProcessContainment,
        request_payload: Zeroizing<Vec<u8>>,
        action: SecretPromptAction,
    ) -> Result<Self, SecretPromptError> {
        let Some(stdin) = child.stdin.take() else {
            terminate_unowned_child(&mut child);
            return Err(SecretPromptError::StdinFailure {
                action,
                message: "Secret prompt stdin was unavailable".to_owned(),
            });
        };
        let Some(stdout) = child.stdout.take() else {
            terminate_unowned_child(&mut child);
            return Err(SecretPromptError::ProtocolFailure {
                message: "Secret prompt stdout was unavailable".to_owned(),
            });
        };
        let Some(stderr) = child.stderr.take() else {
            terminate_unowned_child(&mut child);
            return Err(SecretPromptError::ProtocolFailure {
                message: "Secret prompt stderr was unavailable".to_owned(),
            });
        };
        let mut writer = match PromptWriterTask::spawn(stdin, request_payload, action) {
            Ok(writer) => writer,
            Err(error) => {
                terminate_unowned_child(&mut child);
                return Err(error);
            }
        };
        let mut stdout = match PromptReaderTask::spawn(
            stdout,
            SECRET_PROMPT_MAX_RESPONSE_BYTES + 1,
            SECRET_PROMPT_STDOUT_STREAM_NAME,
            action,
        ) {
            Ok(stdout) => stdout,
            Err(error) => {
                terminate_unowned_child(&mut child);
                let _ = writer.finish_in_place();
                return Err(error);
            }
        };
        let stderr = match PromptReaderTask::spawn(
            stderr,
            SECRET_PROMPT_MAX_STDERR_BYTES,
            SECRET_PROMPT_STDERR_STREAM_NAME,
            action,
        ) {
            Ok(stderr) => stderr,
            Err(error) => {
                terminate_unowned_child(&mut child);
                let _ = writer.finish_in_place();
                let _ = stdout.finish_in_place();
                return Err(error);
            }
        };
        Ok(Self {
            child: Some(child),
            containment: Some(containment),
            retained_stdin: None,
            writer,
            stdout,
            stderr,
            reaped: false,
        })
    }

    fn poll_io(&mut self) -> Result<(), SecretPromptError> {
        if self.retained_stdin.is_none()
            && let Some(outcome) = self.writer.poll()
        {
            self.retained_stdin = Some(outcome?);
        }
        self.stdout.poll()?;
        self.stderr.poll()?;
        Ok(())
    }

    fn try_wait(
        &mut self,
        action: SecretPromptAction,
    ) -> Result<Option<ExitStatus>, SecretPromptError> {
        self.child
            .as_mut()
            .ok_or_else(|| SecretPromptError::ProtocolFailure {
                message: "Secret prompt child ownership was lost".to_owned(),
            })?
            .try_wait()
            .map(|status| {
                if status.is_some() {
                    self.reaped = true;
                }
                status
            })
            .map_err(|error| SecretPromptError::SpawnFailure {
                action,
                message: format!("Failed to wait for secret prompt helper: {error}"),
            })
    }

    fn finish(
        mut self,
        _status: ExitStatus,
        action: SecretPromptAction,
    ) -> Result<PromptProcessOutput, SecretPromptError> {
        self.reaped = true;
        self.retained_stdin.take();
        let writer = self.writer.finish_in_place();
        let stdout = self.stdout.finish_in_place();
        let stderr = self.stderr.finish_in_place();
        self.child.take();
        self.containment.take();
        writer?;
        Ok(PromptProcessOutput {
            stdout: stdout.map_err(|error| error.for_action(action))?,
            stderr: stderr.map_err(|error| error.for_action(action))?,
        })
    }

    fn kill_and_reap(&mut self) {
        self.retained_stdin.take();
        if !self.reaped
            && let Some(child) = self.child.as_mut()
        {
            let _ = child.kill();
            let _ = child.wait();
            self.reaped = true;
        }
        let _ = self.writer.finish_in_place();
        let _ = self.stdout.finish_in_place();
        let _ = self.stderr.finish_in_place();
        self.child.take();
        self.containment.take();
    }
}

fn terminate_unowned_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

impl Drop for PromptProcess {
    fn drop(&mut self) {
        self.kill_and_reap();
    }
}

struct PromptWriterTask {
    receiver: Receiver<Result<ChildStdin, SecretPromptError>>,
    handle: Option<JoinHandle<()>>,
    completed: bool,
}

impl PromptWriterTask {
    fn spawn(
        mut stdin: ChildStdin,
        request_payload: Zeroizing<Vec<u8>>,
        action: SecretPromptAction,
    ) -> Result<Self, SecretPromptError> {
        let (sender, receiver) = mpsc::channel();
        let handle = thread::Builder::new()
            .name(SECRET_PROMPT_WRITER_THREAD_NAME.to_owned())
            .spawn(move || {
                let outcome = stdin
                    .write_all(&request_payload)
                    .and_then(|()| stdin.flush())
                    .map(|()| stdin)
                    .map_err(|error| SecretPromptError::StdinFailure {
                        action,
                        message: error.to_string(),
                    });
                let _ = sender.send(outcome);
            })
            .map_err(|error| SecretPromptError::StdinFailure {
                action,
                message: format!("Failed to start secret prompt writer: {error}"),
            })?;
        Ok(Self {
            receiver,
            handle: Some(handle),
            completed: false,
        })
    }

    fn poll(&mut self) -> Option<Result<ChildStdin, SecretPromptError>> {
        match self.receiver.try_recv() {
            Ok(outcome) => {
                self.completed = true;
                Some(outcome)
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) if self.completed => None,
            Err(TryRecvError::Disconnected) => {
                self.completed = true;
                Some(Err(SecretPromptError::ProtocolFailure {
                    message: "Secret prompt writer stopped without a result".to_owned(),
                }))
            }
        }
    }

    fn finish_in_place(&mut self) -> Result<(), SecretPromptError> {
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        if self.completed {
            return Ok(());
        }
        self.completed = true;
        match self.receiver.recv() {
            Ok(Ok(_stdin)) => Ok(()),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(SecretPromptError::ProtocolFailure {
                message: "Secret prompt writer stopped without a result".to_owned(),
            }),
        }
    }
}

struct PromptReaderTask {
    receiver: Receiver<Result<Zeroizing<Vec<u8>>, PromptReadFailure>>,
    handle: Option<JoinHandle<()>>,
    outcome: Option<Result<Zeroizing<Vec<u8>>, PromptReadFailure>>,
    action: SecretPromptAction,
}

impl PromptReaderTask {
    fn spawn<R>(
        mut reader: R,
        max_bytes: usize,
        stream_name: &'static str,
        action: SecretPromptAction,
    ) -> Result<Self, SecretPromptError>
    where
        R: Read + Send + 'static,
    {
        let (sender, receiver) = mpsc::channel();
        let handle = thread::Builder::new()
            .name(format!("secret-prompt-{stream_name}"))
            .spawn(move || {
                let mut output = Zeroizing::new(Vec::new());
                let mut chunk = Zeroizing::new([0_u8; SECRET_PROMPT_IO_CHUNK_BYTES]);
                let outcome = loop {
                    match reader.read(&mut *chunk) {
                        Ok(0) => break Ok(output),
                        Ok(read) => {
                            if output.len().saturating_add(read) > max_bytes {
                                break Err(PromptReadFailure::Oversized {
                                    stream_name,
                                    max_bytes,
                                });
                            }
                            output.extend_from_slice(&chunk[..read]);
                            chunk[..read].zeroize();
                        }
                        Err(error) => {
                            break Err(PromptReadFailure::Io {
                                stream_name,
                                message: error.to_string(),
                            });
                        }
                    }
                };
                let _ = sender.send(outcome);
            })
            .map_err(|error| SecretPromptError::SpawnFailure {
                action,
                message: format!("Failed to start secret prompt {stream_name} reader: {error}"),
            })?;
        Ok(Self {
            receiver,
            handle: Some(handle),
            outcome: None,
            action,
        })
    }

    fn poll(&mut self) -> Result<(), SecretPromptError> {
        if self.outcome.is_none() {
            match self.receiver.try_recv() {
                Ok(outcome) => self.outcome = Some(outcome),
                Err(TryRecvError::Empty) => return Ok(()),
                Err(TryRecvError::Disconnected) => {
                    return Err(SecretPromptError::ProtocolFailure {
                        message: "Secret prompt output reader stopped without a result".to_owned(),
                    });
                }
            }
        }
        match self.outcome.as_ref() {
            Some(Err(error)) => Err(error.clone().for_action(self.action)),
            _ => Ok(()),
        }
    }

    fn finish_in_place(&mut self) -> Result<Zeroizing<Vec<u8>>, PromptReadFailure> {
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        if self.outcome.is_none() {
            self.outcome = Some(self.receiver.recv().unwrap_or_else(|_| {
                Err(PromptReadFailure::Io {
                    stream_name: SECRET_PROMPT_OUTPUT_STREAM_NAME,
                    message: "reader stopped without a result".to_owned(),
                })
            }));
        }
        self.outcome
            .take()
            .unwrap_or_else(|| Ok(Zeroizing::new(Vec::new())))
    }
}

#[derive(Clone, Debug)]
enum PromptReadFailure {
    Oversized {
        stream_name: &'static str,
        max_bytes: usize,
    },
    Io {
        stream_name: &'static str,
        message: String,
    },
}

impl PromptReadFailure {
    fn for_action(self, action: SecretPromptAction) -> SecretPromptError {
        match self {
            Self::Oversized {
                stream_name,
                max_bytes,
            } => SecretPromptError::ProtocolFailure {
                message: format!(
                    "Secret prompt {stream_name} exceeded {max_bytes} bytes for {}",
                    action.as_cli_arg()
                ),
            },
            Self::Io {
                stream_name,
                message,
            } => SecretPromptError::ProtocolFailure {
                message: format!("Secret prompt {stream_name} read failed: {message}"),
            },
        }
    }
}

fn parse_prompt_response(
    raw_stdout: &[u8],
    action: SecretPromptAction,
) -> Result<SecretPromptResponse, SecretPromptError> {
    if !raw_stdout.ends_with(b"\n") {
        return Err(SecretPromptError::ProtocolFailure {
            message: format!(
                "Secret prompt produced an incomplete response for {}",
                action.as_cli_arg()
            ),
        });
    }
    let response_payload = &raw_stdout[..raw_stdout.len() - 1];
    let response_payload = response_payload
        .strip_suffix(b"\r")
        .unwrap_or(response_payload);
    if response_payload.is_empty() || response_payload.contains(&b'\n') {
        return Err(SecretPromptError::ProtocolFailure {
            message: format!(
                "Secret prompt produced an invalid response frame for {}",
                action.as_cli_arg()
            ),
        });
    }
    serde_json::from_slice(response_payload).map_err(|error| SecretPromptError::ProtocolFailure {
        message: format!("Invalid secret prompt response JSON: {error}"),
    })
}

pub struct ImportPromptOutput {
    pub label: String,
    pub private_key: Zeroizing<String>,
    pub passphrase: Zeroizing<String>,
    pub passphrase_confirmation: Zeroizing<String>,
}

pub struct UnlockPromptOutput {
    pub passphrase: Zeroizing<String>,
}

pub struct RemoveConfirmPromptOutput {
    pub passphrase: Zeroizing<String>,
    pub typed_confirmation: String,
}

pub struct ExportConfirmPromptOutput {
    pub passphrase: Zeroizing<String>,
    pub typed_confirmation: String,
}

pub struct ExportRevealPromptInput {
    pub wallet_label: String,
    pub wallet_address: String,
    pub private_key: Zeroizing<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SecretPromptError {
    #[error("Secret prompt sidecar could not start for {action:?}: {message}")]
    SpawnFailure {
        action: SecretPromptAction,
        message: String,
    },
    #[error("Secret prompt containment failed for {action:?}: {message}")]
    ContainmentFailure {
        action: SecretPromptAction,
        message: String,
    },
    #[error("Secret prompt sidecar stdin write failed for {action:?}: {message}")]
    StdinFailure {
        action: SecretPromptAction,
        message: String,
    },
    #[error("Secret prompt {requested:?} was blocked by active prompt {active:?}")]
    Busy {
        active: SecretPromptAction,
        requested: SecretPromptAction,
    },
    #[error("Secret prompt was cancelled by its lifecycle owner for {action:?}")]
    LifecycleCancelled { action: SecretPromptAction },
    #[error("Secret prompt was cancelled for {action:?}")]
    Cancelled { action: SecretPromptAction },
    #[error("Secret prompt timed out for {action:?}")]
    Timeout { action: SecretPromptAction },
    #[error("Secret prompt helper failed for {action:?}: {message}")]
    HelperFailure {
        action: SecretPromptAction,
        code: SecretPromptErrorCode,
        message: String,
    },
    #[error(
        "Secret prompt returned an unexpected response: expected {expected:?}, got {received:?}"
    )]
    UnexpectedResponse {
        expected: SecretPromptAction,
        received: SecretPromptAction,
    },
    #[error("Secret prompt protocol failed: {message}")]
    ProtocolFailure { message: String },
    #[error("Secret prompt coordinator failed")]
    CoordinatorFailure,
}

#[cfg(test)]
mod tests {
    use super::*;
    use artgod_secret_prompt_protocol::{
        ErrorSecretPromptResponse, ExportConfirmSecretPromptRequest,
        ExportRevealSecretPromptRequest, ImportSecretPromptRequest,
        RemoveConfirmSecretPromptRequest, SecretPromptResponse, UnlockSecretPromptRequest,
        UnlockSecretPromptResponse,
    };
    use serde::Deserialize;
    use std::fs;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;
    use tempfile::tempdir;

    const TEST_NODE_PROGRAM: &str = "node";
    const TEST_FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/secret-prompt-process-fixture.mjs"
    );
    const TEST_FIXTURE_CONTRACT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/secret-prompt-process-fixture-contract.json"
    ));
    const TEST_START_TIMEOUT: Duration = Duration::from_secs(10);
    const TEST_EXIT_TIMEOUT: Duration = Duration::from_secs(10);
    const TEST_POLL_INTERVAL: Duration = Duration::from_millis(20);
    #[cfg(unix)]
    const TEST_PARENT_ENTRY: &str =
        "wallet::infra::prompt::secret_prompt_sidecar::tests::prompt_parent_fixture_entry";
    #[cfg(unix)]
    const TEST_PARENT_MODE_ENV: &str = "ARTGOD_PROMPT_PARENT_CONTAINMENT_TEST_MODE";
    #[cfg(unix)]
    const TEST_PID_PATH_ENV: &str = "ARTGOD_PROMPT_PARENT_CONTAINMENT_PID_PATH";
    #[cfg(unix)]
    const TEST_READY_PATH_ENV: &str = "ARTGOD_PROMPT_PARENT_CONTAINMENT_READY_PATH";

    #[derive(Debug, Deserialize)]
    struct TestFixtureContract {
        modes: TestFixtureModes,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TestFixtureModes {
        hold: String,
        blocked_writer: String,
        valid_response: String,
        gated_response: String,
        malformed_response: String,
        oversized_stdout: String,
        oversized_stderr: String,
    }

    #[derive(Clone, Copy, Debug)]
    enum TestFixtureMode {
        Hold,
        BlockedWriter,
        ValidResponse,
        GatedResponse,
        MalformedResponse,
        OversizedStdout,
        OversizedStderr,
    }

    impl TestFixtureMode {
        fn as_arg(self) -> &'static str {
            let modes = &test_fixture_contract().modes;
            match self {
                Self::Hold => &modes.hold,
                Self::BlockedWriter => &modes.blocked_writer,
                Self::ValidResponse => &modes.valid_response,
                Self::GatedResponse => &modes.gated_response,
                Self::MalformedResponse => &modes.malformed_response,
                Self::OversizedStdout => &modes.oversized_stdout,
                Self::OversizedStderr => &modes.oversized_stderr,
            }
        }
    }

    fn test_fixture_contract() -> &'static TestFixtureContract {
        static CONTRACT: OnceLock<TestFixtureContract> = OnceLock::new();
        CONTRACT.get_or_init(|| {
            serde_json::from_str(TEST_FIXTURE_CONTRACT)
                .expect("secret prompt process fixture contract is valid")
        })
    }

    #[test]
    fn parse_prompt_response_accepts_one_newline_delimited_json_frame() {
        let response = parse_prompt_response(
            b"{\"type\":\"unlock_submitted\",\"passphrase\":\"top secret\"}\n",
            SecretPromptAction::Unlock,
        )
        .unwrap();

        assert_eq!(
            response,
            SecretPromptResponse::UnlockSubmitted(UnlockSecretPromptResponse {
                passphrase: Zeroizing::new("top secret".to_owned()),
            })
        );
    }

    #[test]
    fn parse_prompt_response_rejects_empty_or_multiple_frames() {
        for raw in [b"".as_slice(), b"\n".as_slice(), b"{}\n{}\n".as_slice()] {
            let error = parse_prompt_response(raw, SecretPromptAction::Import).unwrap_err();
            assert!(matches!(error, SecretPromptError::ProtocolFailure { .. }));
        }
    }

    #[test]
    fn helper_failure_response_roundtrip_is_expected() {
        let response = SecretPromptResponse::Error(ErrorSecretPromptResponse {
            action: SecretPromptAction::Unlock,
            code: SecretPromptErrorCode::UiUnavailable,
            message: "No dialog backend".to_owned(),
        });
        let mut raw = serde_json::to_vec(&response).unwrap();
        raw.push(b'\n');
        let parsed = parse_prompt_response(&raw, SecretPromptAction::Unlock).unwrap();
        assert_eq!(parsed, response);
    }

    #[test]
    fn cloned_sidecars_share_one_global_prompt_slot_across_every_action() {
        let sidecar = SecretPromptSidecar::new();
        let actions = [
            SecretPromptAction::Import,
            SecretPromptAction::Unlock,
            SecretPromptAction::RemoveConfirm,
            SecretPromptAction::ExportConfirm,
            SecretPromptAction::ExportReveal,
        ];

        for active_action in actions {
            let (lease, _) = sidecar.coordinator.reserve(active_action).unwrap();
            for requested_action in actions {
                let error = sidecar
                    .clone()
                    .coordinator
                    .reserve(requested_action)
                    .err()
                    .expect("overlapping prompt should be rejected");
                assert_eq!(
                    error,
                    SecretPromptError::Busy {
                        active: active_action,
                        requested: requested_action,
                    }
                );
            }
            drop(lease);
        }
    }

    #[test]
    fn every_prompt_action_cancels_kills_reaps_and_releases_the_coordinator() {
        for action in test_actions() {
            let temp = tempdir().expect("prompt fixture directory is created");
            let coordinator = Arc::new(SecretPromptCoordinator::default());
            let (mut session, pid_path, ready_path) = spawn_fixture_session(
                &coordinator,
                action,
                TestFixtureMode::Hold,
                temp.path(),
                None,
                Duration::from_secs(30),
            );
            wait_for_file(&ready_path, TEST_START_TIMEOUT);
            let pid = read_pid(&pid_path);

            session.cancel();
            let result = tauri::async_runtime::block_on(&mut session);

            assert_eq!(
                result,
                Err(SecretPromptError::LifecycleCancelled { action })
            );
            assert_process_reaped(pid);
            assert!(coordinator.reserve(SecretPromptAction::Import).is_ok());
        }
    }

    #[test]
    fn blocked_writer_is_cancelled_without_blocking_the_kill_owner() {
        let temp = tempdir().expect("prompt fixture directory is created");
        let coordinator = Arc::new(SecretPromptCoordinator::default());
        let action = SecretPromptAction::Import;
        let (lease, cancellation) = coordinator.reserve(action).unwrap();
        let pid_path = temp.path().join("fixture.pid");
        let ready_path = temp.path().join("fixture.ready");
        let command = fixture_command(TestFixtureMode::BlockedWriter, &pid_path, &ready_path, None);
        let mut payload = Zeroizing::new(vec![b'x'; SECRET_PROMPT_MAX_REQUEST_BYTES]);
        payload.push(b'\n');
        let mut session = PromptSession::spawn(
            command,
            payload,
            action,
            lease,
            cancellation,
            Duration::from_secs(30),
        )
        .unwrap();
        wait_for_file(&ready_path, TEST_START_TIMEOUT);
        let pid = read_pid(&pid_path);
        let started = Instant::now();

        session.cancel();
        let result = tauri::async_runtime::block_on(&mut session);

        assert_eq!(
            result,
            Err(SecretPromptError::LifecycleCancelled { action })
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_process_reaped(pid);
    }

    #[test]
    fn malformed_and_oversized_output_kill_reap_and_join_io_tasks() {
        for mode in [
            TestFixtureMode::MalformedResponse,
            TestFixtureMode::OversizedStdout,
            TestFixtureMode::OversizedStderr,
        ] {
            let temp = tempdir().expect("prompt fixture directory is created");
            let coordinator = Arc::new(SecretPromptCoordinator::default());
            let action = SecretPromptAction::Unlock;
            let (mut session, pid_path, ready_path) = spawn_fixture_session(
                &coordinator,
                action,
                mode,
                temp.path(),
                None,
                Duration::from_secs(30),
            );
            wait_for_file(&ready_path, TEST_START_TIMEOUT);
            let pid = read_pid(&pid_path);

            let result = tauri::async_runtime::block_on(&mut session);

            assert!(matches!(
                result,
                Err(SecretPromptError::ProtocolFailure { .. })
            ));
            assert_process_reaped(pid);
            assert!(coordinator.reserve(SecretPromptAction::Import).is_ok());
        }
    }

    #[test]
    fn timeout_kills_reaps_and_releases_the_coordinator() {
        let temp = tempdir().expect("prompt fixture directory is created");
        let coordinator = Arc::new(SecretPromptCoordinator::default());
        let action = SecretPromptAction::RemoveConfirm;
        let (mut session, pid_path, ready_path) = spawn_fixture_session(
            &coordinator,
            action,
            TestFixtureMode::Hold,
            temp.path(),
            None,
            Duration::from_secs(2),
        );
        wait_for_file(&ready_path, TEST_START_TIMEOUT);
        let pid = read_pid(&pid_path);

        let result = tauri::async_runtime::block_on(&mut session);

        assert_eq!(result, Err(SecretPromptError::Timeout { action }));
        assert_process_reaped(pid);
        assert!(coordinator.reserve(SecretPromptAction::Import).is_ok());
    }

    #[test]
    fn future_drop_kills_reaps_and_releases_only_after_cleanup() {
        let temp = tempdir().expect("prompt fixture directory is created");
        let coordinator = Arc::new(SecretPromptCoordinator::default());
        let (session, pid_path, ready_path) = spawn_fixture_session(
            &coordinator,
            SecretPromptAction::ExportConfirm,
            TestFixtureMode::Hold,
            temp.path(),
            None,
            Duration::from_secs(30),
        );
        wait_for_file(&ready_path, TEST_START_TIMEOUT);
        let pid = read_pid(&pid_path);

        drop(session);

        assert_process_reaped(pid);
        assert!(coordinator.reserve(SecretPromptAction::Import).is_ok());
    }

    #[test]
    fn app_exit_closes_admission_and_waits_for_process_and_io_cleanup() {
        let temp = tempdir().expect("prompt fixture directory is created");
        let coordinator = Arc::new(SecretPromptCoordinator::default());
        let action = SecretPromptAction::ExportReveal;
        let (mut session, pid_path, ready_path) = spawn_fixture_session(
            &coordinator,
            action,
            TestFixtureMode::Hold,
            temp.path(),
            None,
            Duration::from_secs(30),
        );
        wait_for_file(&ready_path, TEST_START_TIMEOUT);
        let pid = read_pid(&pid_path);

        coordinator.shutdown_and_wait().unwrap();
        let result = tauri::async_runtime::block_on(&mut session);

        assert_eq!(
            result,
            Err(SecretPromptError::LifecycleCancelled { action })
        );
        assert_process_reaped(pid);
        assert_eq!(
            coordinator.reserve(SecretPromptAction::Import).err(),
            Some(SecretPromptError::LifecycleCancelled {
                action: SecretPromptAction::Import,
            })
        );
    }

    #[test]
    fn response_and_cancellation_race_has_one_terminal_result() {
        for iteration in 0..16 {
            let temp = tempdir().expect("prompt fixture directory is created");
            let coordinator = Arc::new(SecretPromptCoordinator::default());
            let action = SecretPromptAction::Unlock;
            let gate_path = temp.path().join(format!("fixture-{iteration}.gate"));
            let (mut session, pid_path, ready_path) = spawn_fixture_session(
                &coordinator,
                action,
                TestFixtureMode::GatedResponse,
                temp.path(),
                Some(&gate_path),
                Duration::from_secs(30),
            );
            wait_for_file(&ready_path, TEST_START_TIMEOUT);
            let pid = read_pid(&pid_path);

            fs::write(&gate_path, b"respond").expect("fixture response gate is opened");
            session.cancel();
            let result = tauri::async_runtime::block_on(&mut session);

            assert!(matches!(
                result,
                Ok(SecretPromptResponse::UnlockSubmitted(_))
                    | Err(SecretPromptError::LifecycleCancelled { .. })
            ));
            assert_process_reaped(pid);
            assert!(coordinator.reserve(SecretPromptAction::Import).is_ok());
        }
    }

    #[test]
    fn valid_fixture_response_completes_with_retained_stdin_until_exit() {
        let temp = tempdir().expect("prompt fixture directory is created");
        let coordinator = Arc::new(SecretPromptCoordinator::default());
        let action = SecretPromptAction::ExportReveal;
        let (mut session, pid_path, ready_path) = spawn_fixture_session(
            &coordinator,
            action,
            TestFixtureMode::ValidResponse,
            temp.path(),
            None,
            Duration::from_secs(30),
        );
        wait_for_file(&ready_path, TEST_START_TIMEOUT);
        let pid = read_pid(&pid_path);

        let result = tauri::async_runtime::block_on(&mut session).unwrap();

        assert!(matches!(
            result,
            SecretPromptResponse::ExportRevealAcknowledged(_)
        ));
        assert_process_reaped(pid);
    }

    #[test]
    fn secret_bearing_protocol_and_io_owners_use_zeroizing_storage() {
        let request = test_request(SecretPromptAction::ExportReveal);
        let SecretPromptRequest::ExportReveal(payload) = request else {
            panic!("export reveal fixture request is expected");
        };
        require_zeroizing_string(&payload.private_key);

        let response = parse_prompt_response(
            b"{\"type\":\"unlock_submitted\",\"passphrase\":\"secret\"}\n",
            SecretPromptAction::Unlock,
        )
        .unwrap();
        let SecretPromptResponse::UnlockSubmitted(payload) = response else {
            panic!("unlock fixture response is expected");
        };
        require_zeroizing_string(&payload.passphrase);

        let request_payload = serialize_test_request(SecretPromptAction::ExportReveal);
        require_zeroizing_bytes(&request_payload);

        let mut stdout_reader = PromptReaderTask::spawn(
            Cursor::new(b"stdout fixture".to_vec()),
            SECRET_PROMPT_MAX_RESPONSE_BYTES,
            SECRET_PROMPT_STDOUT_STREAM_NAME,
            SecretPromptAction::ExportReveal,
        )
        .unwrap();
        let mut stderr_reader = PromptReaderTask::spawn(
            Cursor::new(b"stderr fixture".to_vec()),
            SECRET_PROMPT_MAX_STDERR_BYTES,
            SECRET_PROMPT_STDERR_STREAM_NAME,
            SecretPromptAction::ExportReveal,
        )
        .unwrap();
        let output = PromptProcessOutput {
            stdout: stdout_reader.finish_in_place().unwrap(),
            stderr: stderr_reader.finish_in_place().unwrap(),
        };
        require_zeroizing_bytes(&output.stdout);
        require_zeroizing_bytes(&output.stderr);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "hard parent-death prompt proof runs in desktop containment jobs"]
    fn export_reveal_fixture_never_survives_hard_parent_death() {
        let temp = tempdir().expect("prompt fixture directory is created");
        let pid_path = temp.path().join("export-reveal.pid");
        let ready_path = temp.path().join("export-reveal.ready");
        let mut parent = Command::new(std::env::current_exe().expect("test executable exists"));
        parent
            .args(["--ignored", "--exact", TEST_PARENT_ENTRY, "--nocapture"])
            .env(TEST_PARENT_MODE_ENV, "1")
            .env(TEST_PID_PATH_ENV, &pid_path)
            .env(TEST_READY_PATH_ENV, &ready_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut parent = parent.spawn().expect("prompt parent fixture starts");
        wait_for_file(&ready_path, TEST_START_TIMEOUT);
        let helper_pid = read_pid(&pid_path);

        parent.kill().expect("prompt parent fixture is hard-killed");
        parent.wait().expect("prompt parent fixture is reaped");

        wait_for_process_exit(helper_pid, TEST_EXIT_TIMEOUT);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "test-only parent process entry for hard parent-death proof"]
    fn prompt_parent_fixture_entry() {
        if std::env::var_os(TEST_PARENT_MODE_ENV).is_none() {
            return;
        }
        let pid_path = required_test_path(TEST_PID_PATH_ENV);
        let ready_path = required_test_path(TEST_READY_PATH_ENV);
        let coordinator = Arc::new(SecretPromptCoordinator::default());
        let (lease, cancellation) = coordinator
            .reserve(SecretPromptAction::ExportReveal)
            .unwrap();
        let command = fixture_command(TestFixtureMode::Hold, &pid_path, &ready_path, None);
        let payload = serialize_test_request(SecretPromptAction::ExportReveal);
        let session = PromptSession::spawn(
            command,
            payload,
            SecretPromptAction::ExportReveal,
            lease,
            cancellation,
            Duration::from_secs(60),
        )
        .unwrap();
        let _ = tauri::async_runtime::block_on(session);
    }

    fn spawn_fixture_session(
        coordinator: &Arc<SecretPromptCoordinator>,
        action: SecretPromptAction,
        mode: TestFixtureMode,
        directory: &Path,
        gate_path: Option<&Path>,
        timeout: Duration,
    ) -> (PromptSession, PathBuf, PathBuf) {
        let pid_path = directory.join(format!("{}.pid", action.as_cli_arg()));
        let ready_path = directory.join(format!("{}.ready", action.as_cli_arg()));
        let command = fixture_command(mode, &pid_path, &ready_path, gate_path);
        let (lease, cancellation) = coordinator.reserve(action).unwrap();
        let session = PromptSession::spawn(
            command,
            serialize_test_request(action),
            action,
            lease,
            cancellation,
            timeout,
        )
        .unwrap();
        (session, pid_path, ready_path)
    }

    fn fixture_command(
        mode: TestFixtureMode,
        pid_path: &Path,
        ready_path: &Path,
        gate_path: Option<&Path>,
    ) -> Command {
        let mut command = Command::new(TEST_NODE_PROGRAM);
        command
            .arg(TEST_FIXTURE_PATH)
            .arg(mode.as_arg())
            .arg(pid_path)
            .arg(ready_path);
        if let Some(gate_path) = gate_path {
            command.arg(gate_path);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn serialize_test_request(action: SecretPromptAction) -> Zeroizing<Vec<u8>> {
        let mut payload = Zeroizing::new(
            serde_json::to_vec(&test_request(action)).expect("fixture request serializes"),
        );
        payload.push(b'\n');
        payload
    }

    fn test_request(action: SecretPromptAction) -> SecretPromptRequest {
        match action {
            SecretPromptAction::Import => SecretPromptRequest::Import(ImportSecretPromptRequest {
                wallet_label_hint: Some("Fixture wallet".to_owned()),
                passphrase_min_length: 12,
            }),
            SecretPromptAction::Unlock => SecretPromptRequest::Unlock(UnlockSecretPromptRequest {
                wallet_label: "Fixture wallet".to_owned(),
                wallet_address: "0x0000000000000000000000000000000000000001".to_owned(),
                reason: "test prompt lifecycle".to_owned(),
                bidding_mandate: None,
            }),
            SecretPromptAction::RemoveConfirm => {
                SecretPromptRequest::RemoveConfirm(RemoveConfirmSecretPromptRequest {
                    wallet_label: "Fixture wallet".to_owned(),
                    wallet_address: "0x0000000000000000000000000000000000000001".to_owned(),
                    expected_confirmation: "REMOVE".to_owned(),
                })
            }
            SecretPromptAction::ExportConfirm => {
                SecretPromptRequest::ExportConfirm(ExportConfirmSecretPromptRequest {
                    wallet_label: "Fixture wallet".to_owned(),
                    wallet_address: "0x0000000000000000000000000000000000000001".to_owned(),
                    expected_confirmation: "EXPORT".to_owned(),
                })
            }
            SecretPromptAction::ExportReveal => {
                SecretPromptRequest::ExportReveal(ExportRevealSecretPromptRequest {
                    wallet_label: "Fixture wallet".to_owned(),
                    wallet_address: "0x0000000000000000000000000000000000000001".to_owned(),
                    private_key: Zeroizing::new("0xfixture-private-key".to_owned()),
                })
            }
        }
    }

    fn test_actions() -> [SecretPromptAction; 5] {
        [
            SecretPromptAction::Import,
            SecretPromptAction::Unlock,
            SecretPromptAction::RemoveConfirm,
            SecretPromptAction::ExportConfirm,
            SecretPromptAction::ExportReveal,
        ]
    }

    fn wait_for_file(path: &Path, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while !path.is_file() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            thread::sleep(TEST_POLL_INTERVAL);
        }
    }

    fn read_pid(path: &Path) -> u32 {
        fs::read_to_string(path)
            .expect("fixture pid is readable")
            .trim()
            .parse()
            .expect("fixture pid is valid")
    }

    #[cfg(unix)]
    fn assert_process_reaped(pid: u32) {
        wait_for_process_exit(pid, TEST_EXIT_TIMEOUT);
    }

    #[cfg(not(unix))]
    fn assert_process_reaped(_pid: u32) {}

    #[cfg(unix)]
    fn wait_for_process_exit(pid: u32, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while process_is_alive(pid) {
            assert!(
                Instant::now() < deadline,
                "prompt fixture process {pid} survived cleanup"
            );
            thread::sleep(TEST_POLL_INTERVAL);
        }
    }

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", pid.to_string().as_str()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(unix)]
    fn required_test_path(key: &str) -> PathBuf {
        std::env::var_os(key)
            .map(PathBuf::from)
            .unwrap_or_else(|| panic!("required prompt containment test path is missing: {key}"))
    }

    fn require_zeroizing_string(_value: &Zeroizing<String>) {}

    fn require_zeroizing_bytes(_value: &Zeroizing<Vec<u8>>) {}
}
