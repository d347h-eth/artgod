//! Startup-only recovery contracts. Domain repair decisions stay in each task.
use std::process::Child;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StartupPhase {
    Preparing,
    Recovery,
    Services,
    Cleanup,
    Backoff,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryTaskId {
    NatsMaintenance,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryFailureReason {
    Failed,
    TimedOut,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryFailure {
    pub task: RecoveryTaskId,
    pub reason: RecoveryFailureReason,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupActivity {
    pub phase: StartupPhase,
    pub task: Option<RecoveryTaskId>,
    pub started_at_ms: u64,
    pub deadline_at_ms: u64,
}

impl StartupActivity {
    /// Wall-clock timestamps are presentation/reconciliation data, never execution clocks.
    pub fn new(phase: StartupPhase, task: Option<RecoveryTaskId>, budget: Duration) -> Self {
        let started_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self {
            phase,
            task,
            started_at_ms,
            deadline_at_ms: started_at_ms.saturating_add(budget.as_millis() as u64),
        }
    }
}

pub struct RecoveryTask {
    pub id: RecoveryTaskId,
    pub process_name: &'static str,
    pub artifact: &'static str,
    pub budget: Duration,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryOutcome {
    Completed,
    Cancelled,
    TimedOut,
    Failed(String),
}

/// A recovery runner owns the process until finalization has completed. Callers
/// may admit producers only after this function returns Completed.
#[cfg(test)]
pub fn execute_recovery_process<P>(
    budget: Duration,
    spawn: impl FnOnce() -> Result<P, String>,
    child: impl FnMut(&mut P) -> &mut Child,
    cancelled: impl FnMut() -> bool,
    poll_interval: Duration,
    finalize: impl FnOnce(&mut P, &RecoveryOutcome),
) -> RecoveryOutcome {
    let deadline = Instant::now() + budget;
    execute_recovery_process_until(deadline, spawn, child, cancelled, poll_interval, finalize)
}

/// Multiple prerequisite steps can share one deadline without renewing it.
pub fn execute_recovery_process_until<P>(
    deadline: Instant,
    spawn: impl FnOnce() -> Result<P, String>,
    mut child: impl FnMut(&mut P) -> &mut Child,
    mut cancelled: impl FnMut() -> bool,
    poll_interval: Duration,
    finalize: impl FnOnce(&mut P, &RecoveryOutcome),
) -> RecoveryOutcome {
    if cancelled() {
        return RecoveryOutcome::Cancelled;
    }
    if Instant::now() >= deadline {
        return RecoveryOutcome::TimedOut;
    }
    let mut process = match spawn() {
        Ok(process) => process,
        Err(error) => return RecoveryOutcome::Failed(error),
    };
    let outcome = wait_for_recovery_child(child(&mut process), deadline, cancelled, poll_interval);
    finalize(&mut process, &outcome);
    outcome
}

/// One attempt, with a monotonic work deadline established before spawning.
/// The caller owns cleanup on every outcome and must finish it before retry/start.
pub fn wait_for_recovery_child(
    child: &mut Child,
    deadline: Instant,
    mut cancelled: impl FnMut() -> bool,
    poll_interval: Duration,
) -> RecoveryOutcome {
    loop {
        // Cancellation and deadline win over an exit observed at the boundary.
        if cancelled() {
            return RecoveryOutcome::Cancelled;
        }
        if Instant::now() >= deadline {
            return RecoveryOutcome::TimedOut;
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return RecoveryOutcome::Completed,
            Ok(Some(status)) => {
                return RecoveryOutcome::Failed(format!("Recovery child exited with {status}"));
            }
            Ok(None) => {}
            Err(error) => {
                return RecoveryOutcome::Failed(format!("Recovery child poll failed: {error}"));
            }
        }
        thread::sleep(poll_interval.min(deadline.saturating_duration_since(Instant::now())));
    }
}

/// A long-lived prerequisite must stay alive while becoming ready. The caller
/// retains ownership on success and cleans up on every other outcome. Probes
/// must have their own short I/O timeout; they never renew the shared deadline.
pub fn wait_for_recovery_service(
    child: &mut Child,
    deadline: Instant,
    mut ready: impl FnMut() -> bool,
    mut cancelled: impl FnMut() -> bool,
    poll_interval: Duration,
) -> RecoveryOutcome {
    loop {
        if cancelled() {
            return RecoveryOutcome::Cancelled;
        }
        if Instant::now() >= deadline {
            return RecoveryOutcome::TimedOut;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return RecoveryOutcome::Failed(format!(
                    "Recovery prerequisite exited with {status}"
                ));
            }
            Err(error) => {
                return RecoveryOutcome::Failed(format!(
                    "Recovery prerequisite poll failed: {error}"
                ));
            }
            Ok(None) => {}
        }
        let is_ready = ready();
        if cancelled() {
            return RecoveryOutcome::Cancelled;
        }
        if Instant::now() >= deadline {
            return RecoveryOutcome::TimedOut;
        }
        if is_ready {
            return RecoveryOutcome::Completed;
        }
        thread::sleep(poll_interval.min(deadline.saturating_duration_since(Instant::now())));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};

    const SUCCESS_FIXTURE: &str = "runtime::recovery::tests::recovery_child_success";
    const FAILURE_FIXTURE: &str = "runtime::recovery::tests::recovery_child_failure";
    const HUNG_FIXTURE: &str = "runtime::recovery::tests::recovery_child_hung";

    fn spawn_fixture(entry: &str) -> Child {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp/recovery-native-tests");
        std::fs::create_dir_all(&root).unwrap();
        // Preserve every synthetic fixture and log, including successful runs.
        let dir = tempfile::Builder::new()
            .prefix("child-")
            .tempdir_in(root)
            .unwrap()
            .keep();
        let log = File::create(dir.join("child.log")).unwrap();
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", entry])
            .current_dir(dir)
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap()
    }

    #[test]
    fn recovery_child_outcomes_cleanup_and_retry() {
        for (entry, cancel, budget, expected) in [
            (
                SUCCESS_FIXTURE,
                false,
                Duration::from_secs(5),
                RecoveryOutcome::Completed,
            ),
            (
                HUNG_FIXTURE,
                false,
                Duration::from_millis(30),
                RecoveryOutcome::TimedOut,
            ),
            (
                HUNG_FIXTURE,
                true,
                Duration::from_secs(5),
                RecoveryOutcome::Cancelled,
            ),
        ] {
            let finalized = AtomicBool::new(false);
            let outcome = execute_recovery_process(
                budget,
                || Ok(spawn_fixture(entry)),
                |child| child,
                || cancel,
                Duration::from_millis(5),
                |child, _| {
                    if child.try_wait().unwrap().is_none() {
                        child.kill().unwrap();
                    }
                    child.wait().unwrap();
                    assert!(child.try_wait().unwrap().is_some());
                    finalized.store(true, Ordering::SeqCst);
                },
            );
            assert_eq!(outcome, expected);
            assert_eq!(
                finalized.load(Ordering::SeqCst),
                !cancel,
                "cancel before spawn creates no child; otherwise cleanup precedes return"
            );
        }
        // A fresh attempt after cancellation/timeout can actually execute.
        let outcome = execute_recovery_process(
            Duration::from_secs(5),
            || Ok(spawn_fixture(SUCCESS_FIXTURE)),
            |child| child,
            || false,
            Duration::from_millis(5),
            |child, _| {
                child.wait().unwrap();
            },
        );
        assert_eq!(outcome, RecoveryOutcome::Completed);
    }

    #[test]
    fn recovery_failure_never_becomes_success_or_retries_itself() {
        let mut spawns = 0;
        let outcome = execute_recovery_process(
            Duration::from_secs(5),
            || {
                spawns += 1;
                Ok(spawn_fixture(FAILURE_FIXTURE))
            },
            |child| child,
            || false,
            Duration::from_millis(5),
            |child, _| {
                child.wait().unwrap();
            },
        );
        assert!(matches!(outcome, RecoveryOutcome::Failed(_)));
        assert_eq!(spawns, 1);
        let outcome = execute_recovery_process::<Child>(
            Duration::from_secs(5),
            || Err("missing artifact".to_owned()),
            |child| child,
            || false,
            Duration::from_millis(5),
            |_, _| panic!("no child to finalize"),
        );
        assert_eq!(
            outcome,
            RecoveryOutcome::Failed("missing artifact".to_owned())
        );
    }

    #[test]
    fn recovery_deadline_and_stop_win_over_late_success() {
        let mut child = spawn_fixture(SUCCESS_FIXTURE);
        child.wait().unwrap();
        assert_eq!(
            wait_for_recovery_child(
                &mut child,
                Instant::now(),
                || false,
                Duration::from_millis(1)
            ),
            RecoveryOutcome::TimedOut
        );
        assert_eq!(
            wait_for_recovery_child(
                &mut child,
                Instant::now() + Duration::from_secs(1),
                || true,
                Duration::from_millis(1)
            ),
            RecoveryOutcome::Cancelled
        );
    }

    #[test]
    fn recovery_prerequisite_exit_is_terminal_even_if_another_listener_is_ready() {
        let mut child = spawn_fixture(FAILURE_FIXTURE);
        child.wait().unwrap();
        assert!(matches!(
            wait_for_recovery_service(
                &mut child,
                Instant::now() + Duration::from_secs(900),
                || true,
                || false,
                Duration::from_millis(1)
            ),
            RecoveryOutcome::Failed(_)
        ));
    }

    #[test]
    fn prerequisite_readiness_preserves_the_deadline_and_stop_priority() {
        for (cancel, ready, expected) in [
            (false, true, RecoveryOutcome::Completed),
            (true, true, RecoveryOutcome::Cancelled),
            (false, false, RecoveryOutcome::TimedOut),
        ] {
            let mut child = spawn_fixture(HUNG_FIXTURE);
            let outcome = wait_for_recovery_service(
                &mut child,
                Instant::now() + Duration::from_millis(20),
                || ready,
                || cancel,
                Duration::from_millis(1),
            );
            child.kill().unwrap();
            child.wait().unwrap();
            assert_eq!(outcome, expected);
        }
        // A later step cannot spawn after the shared deadline, even if it
        // would otherwise complete immediately.
        assert_eq!(
            execute_recovery_process_until::<Child>(
                Instant::now(),
                || panic!("expired recovery must not spawn the next step"),
                |child| child,
                || false,
                Duration::from_millis(1),
                |_, _| unreachable!()
            ),
            RecoveryOutcome::TimedOut
        );
    }

    #[test]
    #[ignore = "isolated subprocess fixture"]
    fn recovery_child_success() {}
    #[test]
    #[ignore = "isolated subprocess fixture"]
    fn recovery_child_failure() {
        panic!("synthetic recovery failure");
    }
    #[test]
    #[ignore = "isolated subprocess fixture"]
    fn recovery_child_hung() {
        thread::sleep(Duration::from_secs(60));
    }
}
