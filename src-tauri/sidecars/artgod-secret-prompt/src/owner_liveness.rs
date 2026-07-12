use std::io::{self, Read};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;

use winit::event_loop::EventLoopProxy;
use zeroize::Zeroizing;

const TERMINAL_ACTIVE: u8 = 0;
const TERMINAL_UI_COMPLETED: u8 = 1;
const TERMINAL_OWNER_LOST: u8 = 2;
const TERMINAL_PROTOCOL_VIOLATION: u8 = 3;
const STDIN_WATCHER_THREAD_NAME: &str = "secret-prompt-owner-liveness";

/// Forced helper terminal causes delivered to the native prompt event loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OwnerLivenessEvent {
    OwnerLost,
    ProtocolViolation,
}

/// One terminal arbiter shared by stdin liveness and native UI completion.
#[derive(Clone, Default)]
pub(crate) struct OwnerLiveness {
    terminal: Arc<AtomicU8>,
}

impl OwnerLiveness {
    /// Reserves the only successful terminal result for the native UI.
    pub(crate) fn claim_ui_completion(&self) -> bool {
        self.terminal
            .compare_exchange(
                TERMINAL_ACTIVE,
                TERMINAL_UI_COMPLETED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    /// Returns the forced terminal cause if stdin ownership won the race.
    pub(crate) fn forced_event(&self) -> Option<OwnerLivenessEvent> {
        match self.terminal.load(Ordering::Acquire) {
            TERMINAL_OWNER_LOST => Some(OwnerLivenessEvent::OwnerLost),
            TERMINAL_PROTOCOL_VIOLATION => Some(OwnerLivenessEvent::ProtocolViolation),
            _ => None,
        }
    }

    /// Starts watching the retained parent stdin lease before the UI can open.
    pub(crate) fn start_stdin_watcher(
        &self,
        event_proxy: EventLoopProxy<OwnerLivenessEvent>,
    ) -> io::Result<()> {
        let liveness = self.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(0);
        thread::Builder::new()
            .name(STDIN_WATCHER_THREAD_NAME.to_owned())
            .spawn(move || {
                // Publish readiness before the blocking read so the UI may safely start.
                if ready_tx.send(()).is_err() {
                    return;
                }
                watch_owner_input(io::stdin(), &liveness, |event| {
                    let _ = event_proxy.send_event(event);
                });
            })?;
        ready_rx.recv().map_err(|error| {
            io::Error::other(format!(
                "Secret prompt stdin watcher failed before startup: {error}"
            ))
        })
    }

    fn force(&self, event: OwnerLivenessEvent) -> bool {
        let terminal = match event {
            OwnerLivenessEvent::OwnerLost => TERMINAL_OWNER_LOST,
            OwnerLivenessEvent::ProtocolViolation => TERMINAL_PROTOCOL_VIOLATION,
        };
        self.terminal
            .compare_exchange(
                TERMINAL_ACTIVE,
                terminal,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }
}

fn watch_owner_input(
    mut reader: impl Read,
    liveness: &OwnerLiveness,
    notify: impl FnOnce(OwnerLivenessEvent),
) {
    let mut unexpected_byte = Zeroizing::new([0_u8; 1]);
    let event = loop {
        match reader.read(&mut *unexpected_byte) {
            Ok(0) => break OwnerLivenessEvent::OwnerLost,
            Ok(_) => break OwnerLivenessEvent::ProtocolViolation,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break OwnerLivenessEvent::OwnerLost,
        }
    };
    if liveness.force(event) {
        notify(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, Instant};

    const OWNER_LIVENESS_ENTRY: &str = "owner_liveness::tests::owner_liveness_subprocess_entry";
    const OWNER_LIVENESS_READY: &str = "request-read";
    const OWNER_LOSS_REQUEST: &[u8] = b"owner-loss\n";
    const PROTOCOL_VIOLATION_REQUEST: &[u8] = b"protocol-violation\nunexpected";

    #[test]
    fn owner_loss_after_request_read_stops_the_fixture() {
        let mut fixture = spawn_owner_liveness_fixture();
        write_fixture_request(&mut fixture, OWNER_LOSS_REQUEST);
        let _output = wait_until_request_is_read(&mut fixture);

        drop(fixture.stdin.take());
        let status = wait_for_fixture(&mut fixture);

        assert!(status.success());
    }

    #[test]
    fn additional_bytes_after_request_are_a_protocol_violation() {
        let mut fixture = spawn_owner_liveness_fixture();
        write_fixture_request(&mut fixture, PROTOCOL_VIOLATION_REQUEST);
        let _output = wait_until_request_is_read(&mut fixture);

        let status = wait_for_fixture(&mut fixture);

        assert!(status.success());
    }

    #[test]
    fn owner_loss_and_ui_completion_have_one_terminal_winner() {
        for _ in 0..128 {
            let liveness = OwnerLiveness::default();
            let barrier = Arc::new(Barrier::new(3));
            let ui_liveness = liveness.clone();
            let ui_barrier = Arc::clone(&barrier);
            let ui = thread::spawn(move || {
                ui_barrier.wait();
                ui_liveness.claim_ui_completion()
            });
            let owner_liveness = liveness.clone();
            let owner_barrier = Arc::clone(&barrier);
            let owner = thread::spawn(move || {
                owner_barrier.wait();
                owner_liveness.force(OwnerLivenessEvent::OwnerLost)
            });

            barrier.wait();
            let ui_won = ui.join().expect("UI terminal race task completes");
            let owner_won = owner.join().expect("owner terminal race task completes");

            assert_ne!(ui_won, owner_won);
            assert_eq!(
                liveness.forced_event() == Some(OwnerLivenessEvent::OwnerLost),
                owner_won
            );
        }
    }

    #[test]
    fn stdin_read_error_is_owner_loss() {
        let liveness = OwnerLiveness::default();
        let (event_tx, event_rx) = mpsc::sync_channel(1);

        watch_owner_input(FailingReader, &liveness, |event| {
            event_tx.send(event).expect("read error event is reported");
        });

        assert_eq!(
            event_rx.recv().expect("read error event is available"),
            OwnerLivenessEvent::OwnerLost
        );
        assert_eq!(liveness.forced_event(), Some(OwnerLivenessEvent::OwnerLost));
    }

    #[test]
    #[ignore = "test-only subprocess fixture for retained stdin ownership"]
    fn owner_liveness_subprocess_entry() {
        let mut request = Zeroizing::new(String::new());
        let mut stdin = io::stdin().lock();
        stdin
            .read_line(&mut request)
            .expect("fixture request is readable");
        let expected_event = match request.as_str() {
            "owner-loss\n" => OwnerLivenessEvent::OwnerLost,
            "protocol-violation\n" => OwnerLivenessEvent::ProtocolViolation,
            other => panic!("unexpected owner-liveness fixture request: {other:?}"),
        };
        drop(stdin);

        println!("{OWNER_LIVENESS_READY}");
        io::stdout().flush().expect("fixture readiness is flushed");

        let liveness = OwnerLiveness::default();
        let (event_tx, event_rx) = mpsc::sync_channel(1);
        watch_owner_input(io::stdin(), &liveness, |event| {
            event_tx
                .send(event)
                .expect("fixture terminal event is reported");
        });
        let event = event_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("fixture observes terminal stdin state");
        assert_eq!(event, expected_event);
        assert_eq!(liveness.forced_event(), Some(event));
    }

    fn spawn_owner_liveness_fixture() -> std::process::Child {
        Command::new(std::env::current_exe().expect("helper test executable exists"))
            .args(["--ignored", "--exact", OWNER_LIVENESS_ENTRY, "--nocapture"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("owner-liveness fixture starts")
    }

    fn write_fixture_request(fixture: &mut std::process::Child, request: &[u8]) {
        let stdin = fixture.stdin.as_mut().expect("fixture stdin is available");
        stdin
            .write_all(request)
            .expect("fixture request is written");
        stdin.flush().expect("fixture request is flushed");
    }

    fn wait_until_request_is_read(
        fixture: &mut std::process::Child,
    ) -> BufReader<std::process::ChildStdout> {
        let stdout = fixture.stdout.take().expect("fixture stdout is available");
        let mut output = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            let bytes_read = output
                .read_line(&mut line)
                .expect("fixture readiness is readable");
            assert_ne!(bytes_read, 0, "fixture exited before publishing readiness");
            if line.trim() == OWNER_LIVENESS_READY {
                return output;
            }
        }
    }

    fn wait_for_fixture(fixture: &mut std::process::Child) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = fixture
                .try_wait()
                .expect("owner-liveness fixture status is readable")
            {
                return status;
            }
            if Instant::now() >= deadline {
                let _ = fixture.kill();
                let _ = fixture.wait();
                panic!("owner-liveness fixture did not terminate before timeout");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("fixture read failure"))
        }
    }
}
