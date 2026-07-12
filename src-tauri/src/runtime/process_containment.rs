use std::{
    io,
    process::{Child, Command},
};

/// Prepared platform containment that must be attached immediately after spawning the child.
#[must_use = "prepared containment must be attached to the spawned child"]
pub(crate) struct PreparedProcessContainment {
    platform: platform::PreparedProcessContainment,
}

/// Retained platform containment whose lifetime must match the child process lifetime.
#[must_use = "child containment must be retained for the child process lifetime"]
pub(crate) struct ChildProcessContainment {
    _platform: platform::ChildProcessContainment,
}

/// Installs pre-spawn containment and prepares any platform-owned containment resources.
pub(crate) fn prepare_process_containment(
    command: &mut Command,
) -> io::Result<PreparedProcessContainment> {
    platform::prepare(command).map(|platform| PreparedProcessContainment { platform })
}

impl PreparedProcessContainment {
    /// Attaches the spawned child before any secret is written to the process.
    pub(crate) fn attach(self, child: &mut Child) -> io::Result<ChildProcessContainment> {
        self.platform
            .attach(child)
            .map(|platform| ChildProcessContainment {
                _platform: platform,
            })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{
        io,
        os::unix::process::CommandExt,
        process::{Child, Command},
    };

    pub(super) struct PreparedProcessContainment;

    pub(super) struct ChildProcessContainment;

    pub(super) fn prepare(command: &mut Command) -> io::Result<PreparedProcessContainment> {
        let expected_parent_pid = unsafe { libc::getpid() };

        // Configure the kernel-enforced parent-death signal in the child between fork and exec.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
                    return Err(io::Error::last_os_error());
                }

                // Close the fork-to-prctl race if the desktop process already disappeared.
                if libc::getppid() != expected_parent_pid {
                    return Err(io::Error::from_raw_os_error(libc::ESRCH));
                }

                Ok(())
            });
        }

        Ok(PreparedProcessContainment)
    }

    impl PreparedProcessContainment {
        pub(super) fn attach(self, _child: &mut Child) -> io::Result<ChildProcessContainment> {
            Ok(ChildProcessContainment)
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::{
        ffi::c_void,
        io,
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::{Child, Command},
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
    };

    pub(super) struct PreparedProcessContainment {
        job: OwnedHandle,
    }

    pub(super) struct ChildProcessContainment {
        // Closing the retained job handle terminates the child and all descendants in the job.
        _job: OwnedHandle,
    }

    pub(super) fn prepare(_command: &mut Command) -> io::Result<PreparedProcessContainment> {
        // A null security descriptor creates a non-inheritable job handle by default.
        let raw_job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if raw_job.is_null() {
            return Err(io::Error::last_os_error());
        }

        // Transfer ownership immediately so every later error closes the native handle.
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job.cast()) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // Defensively remove inheritance even though CreateJobObjectW already defaults it off.
        if unsafe { SetHandleInformation(raw_job, HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }

        if unsafe {
            SetInformationJobObject(
                raw_job,
                JobObjectExtendedLimitInformation,
                ptr::addr_of!(limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }

        Ok(PreparedProcessContainment { job })
    }

    impl PreparedProcessContainment {
        pub(super) fn attach(self, child: &mut Child) -> io::Result<ChildProcessContainment> {
            let raw_job = self.job.as_raw_handle() as HANDLE;
            let raw_process = child.as_raw_handle() as HANDLE;

            // Assign before the caller can write any wallet secret into the child.
            if unsafe { AssignProcessToJobObject(raw_job, raw_process) } == 0 {
                let assignment_error = io::Error::last_os_error();

                // A process that could not be contained must never continue startup.
                if let Err(kill_error) = child.kill() {
                    return Err(io::Error::other(format!(
                        "{assignment_error}; failed to terminate uncontained child: {kill_error}"
                    )));
                }
                child.wait().map_err(|wait_error| {
                    io::Error::other(format!(
                        "{assignment_error}; failed to reap terminated child: {wait_error}"
                    ))
                })?;
                return Err(assignment_error);
            }

            Ok(ChildProcessContainment { _job: self.job })
        }
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    use std::{
        io,
        process::{Child, Command},
    };

    pub(super) struct PreparedProcessContainment;

    pub(super) struct ChildProcessContainment;

    pub(super) fn prepare(_command: &mut Command) -> io::Result<PreparedProcessContainment> {
        Ok(PreparedProcessContainment)
    }

    impl PreparedProcessContainment {
        pub(super) fn attach(self, _child: &mut Child) -> io::Result<ChildProcessContainment> {
            Ok(ChildProcessContainment)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::prepare_process_containment;
    use std::process::Command;

    #[test]
    fn configured_containment_allows_a_child_to_run() {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit", "0"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = Command::new("true");

        let prepared = prepare_process_containment(&mut command).expect("containment is prepared");
        let mut child = command.spawn().expect("contained child starts");
        let containment = prepared.attach(&mut child).expect("child is contained");

        let status = child.wait().expect("contained child exits");
        assert!(status.success());
        drop(containment);
    }

    #[cfg(unix)]
    mod hard_parent_death {
        use std::fs;
        use std::io::Read;
        use std::path::{Path, PathBuf};
        use std::process::{Command, Stdio};
        use std::sync::mpsc;
        use std::thread;
        use std::time::{Duration, Instant};

        use tempfile::tempdir;

        use super::prepare_process_containment;

        const TEST_ENTRY_NAME: &str =
            "runtime::process_containment::tests::hard_parent_death::containment_test_entry";
        const TEST_MODE_ENV: &str = "ARTGOD_CONTAINMENT_TEST_MODE";
        const TEST_MODE_PARENT: &str = "parent";
        const TEST_MODE_CHILD: &str = "child";
        const TEST_PID_PATH_ENV: &str = "ARTGOD_CONTAINMENT_TEST_PID_PATH";
        const TEST_HEARTBEAT_PATH_ENV: &str = "ARTGOD_CONTAINMENT_TEST_HEARTBEAT_PATH";
        const TEST_START_TIMEOUT: Duration = Duration::from_secs(10);
        const TEST_EXIT_TIMEOUT: Duration = Duration::from_secs(10);
        const TEST_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(50);

        #[test]
        #[ignore = "hard-kill process containment proof runs in desktop build/release jobs"]
        fn hard_parent_death_stops_child_pid_and_activity() {
            let temp = tempdir().expect("containment test directory is created");
            let pid_path = temp.path().join("child.pid");
            let heartbeat_path = temp.path().join("activity.heartbeat");
            let mut parent = spawn_test_entry(TEST_MODE_PARENT, &pid_path, &heartbeat_path);

            wait_for_file(&pid_path, TEST_START_TIMEOUT);
            wait_for_file(&heartbeat_path, TEST_START_TIMEOUT);
            let child_pid = fs::read_to_string(&pid_path)
                .expect("child pid is readable")
                .trim()
                .parse::<u32>()
                .expect("child pid is valid");
            let first_heartbeat =
                fs::read_to_string(&heartbeat_path).expect("initial heartbeat is readable");
            wait_for_heartbeat_change(&heartbeat_path, &first_heartbeat, TEST_START_TIMEOUT);

            // Simulate an ungraceful desktop death instead of sending the normal stop signal.
            parent.kill().expect("test parent is hard-killed");
            parent.wait().expect("test parent is reaped");

            wait_for_process_exit(child_pid, TEST_EXIT_TIMEOUT);
            let stopped_heartbeat =
                fs::read_to_string(&heartbeat_path).expect("stopped heartbeat is readable");
            thread::sleep(TEST_HEARTBEAT_INTERVAL * 3);
            assert_eq!(
                fs::read_to_string(&heartbeat_path).expect("final heartbeat is readable"),
                stopped_heartbeat,
                "contained child activity continued after parent death"
            );
        }

        #[test]
        #[ignore = "subprocess entrypoint for the hard-parent-death proof"]
        fn containment_test_entry() {
            let Ok(mode) = std::env::var(TEST_MODE_ENV) else {
                return;
            };
            let pid_path = required_test_path(TEST_PID_PATH_ENV);
            let heartbeat_path = required_test_path(TEST_HEARTBEAT_PATH_ENV);
            match mode.as_str() {
                TEST_MODE_PARENT => run_test_parent(&pid_path, &heartbeat_path),
                TEST_MODE_CHILD => run_test_child(&heartbeat_path),
                other => panic!("unexpected containment test mode: {other}"),
            }
        }

        fn run_test_parent(pid_path: &Path, heartbeat_path: &Path) {
            let mut command = test_entry_command(TEST_MODE_CHILD, pid_path, heartbeat_path);
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let prepared =
                prepare_process_containment(&mut command).expect("child containment is prepared");
            let mut child = command.spawn().expect("contained test child starts");
            let containment = prepared
                .attach(&mut child)
                .expect("test child is attached to containment");
            let parent_liveness_lease = child.stdin.take().expect("liveness pipe is available");
            fs::write(pid_path, child.id().to_string()).expect("child pid is published");

            let _containment = containment;
            let _parent_liveness_lease = parent_liveness_lease;
            let _ = child.wait();
        }

        fn run_test_child(heartbeat_path: &Path) {
            let (parent_closed_tx, parent_closed_rx) = mpsc::channel();
            thread::spawn(move || {
                let mut input = std::io::stdin().lock();
                let mut sink = Vec::new();
                let _ = input.read_to_end(&mut sink);
                let _ = parent_closed_tx.send(());
            });

            let mut heartbeat = 0_u64;
            loop {
                heartbeat = heartbeat.saturating_add(1);
                fs::write(heartbeat_path, heartbeat.to_string())
                    .expect("test child heartbeat is written");
                if parent_closed_rx
                    .recv_timeout(TEST_HEARTBEAT_INTERVAL)
                    .is_ok()
                {
                    break;
                }
            }
        }

        fn spawn_test_entry(
            mode: &str,
            pid_path: &Path,
            heartbeat_path: &Path,
        ) -> std::process::Child {
            test_entry_command(mode, pid_path, heartbeat_path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("containment test entry starts")
        }

        fn test_entry_command(mode: &str, pid_path: &Path, heartbeat_path: &Path) -> Command {
            let mut command =
                Command::new(std::env::current_exe().expect("test executable exists"));
            command
                .args(["--ignored", "--exact", TEST_ENTRY_NAME, "--nocapture"])
                .env(TEST_MODE_ENV, mode)
                .env(TEST_PID_PATH_ENV, pid_path)
                .env(TEST_HEARTBEAT_PATH_ENV, heartbeat_path);
            command
        }

        fn required_test_path(key: &str) -> PathBuf {
            std::env::var_os(key)
                .map(PathBuf::from)
                .unwrap_or_else(|| panic!("required containment test path is missing: {key}"))
        }

        fn wait_for_file(path: &Path, timeout: Duration) {
            let deadline = Instant::now() + timeout;
            while !path.is_file() {
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for {}",
                    path.display()
                );
                thread::sleep(TEST_HEARTBEAT_INTERVAL);
            }
        }

        fn wait_for_heartbeat_change(path: &Path, previous: &str, timeout: Duration) {
            let deadline = Instant::now() + timeout;
            loop {
                let current = fs::read_to_string(path).unwrap_or_default();
                if !current.is_empty() && current != previous {
                    return;
                }
                assert!(Instant::now() < deadline, "child activity did not start");
                thread::sleep(TEST_HEARTBEAT_INTERVAL);
            }
        }

        fn wait_for_process_exit(pid: u32, timeout: Duration) {
            let deadline = Instant::now() + timeout;
            while process_is_alive(pid) {
                assert!(
                    Instant::now() < deadline,
                    "contained child process {pid} survived"
                );
                thread::sleep(TEST_HEARTBEAT_INTERVAL);
            }
        }

        fn process_is_alive(pid: u32) -> bool {
            Command::new("kill")
                .args(["-0", pid.to_string().as_str()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        }
    }
}
