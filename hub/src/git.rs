use std::{
    collections::HashMap,
    env,
    io::Read,
    process::{Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use crate::protocol::{RuntimeGit, RuntimeGitState};

const GIT_REFRESH_INTERVAL: Duration = Duration::from_secs(2);
const GIT_TIMEOUT: Duration = Duration::from_secs(2);
const GIT_OUTPUT_LIMIT: u64 = 64 * 1024;
const GIT_WORKERS: usize = 2;
const GIT_QUEUE_CAPACITY: usize = 64;
const MAX_BRANCH_BYTES: usize = 1024;

#[derive(Clone)]
struct GitJob {
    instance_id: String,
    cwd: String,
    generation: u64,
}

struct CacheEntry {
    cwd: String,
    generation: u64,
    result: RuntimeGit,
    queued: bool,
    last_started: Option<Instant>,
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, CacheEntry>,
}

pub struct GitMetadataCache {
    state: Arc<Mutex<CacheState>>,
    sender: mpsc::SyncSender<GitJob>,
}

impl Default for GitMetadataCache {
    fn default() -> Self {
        let state = Arc::new(Mutex::new(CacheState::default()));
        let (sender, receiver) = mpsc::sync_channel::<GitJob>(GIT_QUEUE_CAPACITY);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..GIT_WORKERS {
            let worker_state = state.clone();
            let worker_receiver = receiver.clone();
            let _ = thread::Builder::new()
                .name(format!("git-metadata-{index}"))
                .spawn(move || worker_loop(worker_state, worker_receiver));
        }
        Self { state, sender }
    }
}

impl GitMetadataCache {
    pub fn observe(&self, instance_id: &str, cwd: Option<&str>) -> RuntimeGit {
        let Some(cwd) = cwd else {
            return RuntimeGit::unavailable(false);
        };
        let now = Instant::now();
        let mut job = None;
        let result = {
            let Ok(mut state) = self.state.lock() else {
                return RuntimeGit::unavailable(false);
            };
            let entry = state
                .entries
                .entry(instance_id.to_string())
                .or_insert_with(|| CacheEntry {
                    cwd: cwd.to_string(),
                    generation: 1,
                    result: RuntimeGit::pending(),
                    queued: false,
                    last_started: None,
                });
            if entry.cwd != cwd {
                entry.cwd = cwd.to_string();
                entry.generation = entry.generation.wrapping_add(1);
                entry.result = RuntimeGit::pending();
                entry.queued = false;
                entry.last_started = None;
            }
            let refresh_due = entry
                .last_started
                .is_none_or(|started| now.duration_since(started) >= GIT_REFRESH_INTERVAL);
            if !entry.queued && refresh_due {
                entry.queued = true;
                entry.last_started = Some(now);
                job = Some(GitJob {
                    instance_id: instance_id.to_string(),
                    cwd: cwd.to_string(),
                    generation: entry.generation,
                });
            }
            entry.result.clone()
        };
        if let Some(job) = job
            && self.sender.try_send(job.clone()).is_err()
            && let Ok(mut state) = self.state.lock()
            && let Some(entry) = state.entries.get_mut(&job.instance_id)
            && entry.generation == job.generation
        {
            entry.queued = false;
        }
        result
    }

    pub fn take(&self, instance_id: &str) -> RuntimeGit {
        self.state
            .lock()
            .ok()
            .and_then(|mut state| state.entries.remove(instance_id))
            .map(|entry| {
                if entry.result.state == RuntimeGitState::Pending {
                    return RuntimeGit::unavailable(true);
                }
                let mut result = entry.result;
                result.stale = true;
                result
            })
            .unwrap_or_else(|| RuntimeGit::unavailable(true))
    }
}

fn worker_loop(state: Arc<Mutex<CacheState>>, receiver: Arc<Mutex<mpsc::Receiver<GitJob>>>) {
    loop {
        let job = {
            let Ok(receiver) = receiver.lock() else {
                return;
            };
            let Ok(job) = receiver.recv() else { return };
            job
        };
        let still_current = state.lock().ok().is_some_and(|state| {
            state
                .entries
                .get(&job.instance_id)
                .is_some_and(|entry| entry.generation == job.generation && entry.cwd == job.cwd)
        });
        if !still_current {
            continue;
        }
        let result = run_git_probe(&job.cwd);
        if let Ok(mut state) = state.lock()
            && let Some(entry) = state.entries.get_mut(&job.instance_id)
            && entry.generation == job.generation
            && entry.cwd == job.cwd
        {
            entry.queued = false;
            if result.state == RuntimeGitState::Unavailable
                && entry.result.state != RuntimeGitState::Pending
                && entry.result.state != RuntimeGitState::Unavailable
            {
                entry.result.stale = true;
            } else {
                entry.result = result;
            }
        }
    }
}

fn run_git_probe(cwd: &str) -> RuntimeGit {
    let mut command = Command::new("git");
    command
        .args([
            "--no-optional-locks",
            "-C",
            cwd,
            "status",
            "--porcelain=v2",
            "--branch",
            "--no-ahead-behind",
            "--untracked-files=normal",
            "--ignore-submodules=all",
        ])
        .env_clear()
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = env::var_os("PATH") {
        command.env("PATH", path);
    }
    if let Some(system_root) = env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    let Ok(mut child) = command.spawn() else {
        return RuntimeGit::unavailable(false);
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || read_limited(stdout));
    let stderr_reader = thread::spawn(move || read_limited(stderr));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < GIT_TIMEOUT => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if stdout.len() + stderr.len() > GIT_OUTPUT_LIMIT as usize || status.is_none() {
        return RuntimeGit::unavailable(false);
    }
    let Some(status) = status else {
        return RuntimeGit::unavailable(false);
    };
    if !status.success() {
        return if String::from_utf8_lossy(&stderr).contains("not a git repository") {
            RuntimeGit::not_repository()
        } else {
            RuntimeGit::unavailable(false)
        };
    }
    parse_porcelain_v2(&stdout).unwrap_or_else(|| RuntimeGit::unavailable(false))
}

fn read_limited<R: Read>(reader: Option<R>) -> Vec<u8> {
    let Some(reader) = reader else {
        return Vec::new();
    };
    let mut bytes = Vec::new();
    let _ = reader.take(GIT_OUTPUT_LIMIT + 1).read_to_end(&mut bytes);
    bytes
}

fn parse_porcelain_v2(output: &[u8]) -> Option<RuntimeGit> {
    let text = std::str::from_utf8(output).ok()?;
    let mut branch_seen = false;
    let mut branch = None;
    let mut detached = false;
    let mut dirty = false;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("# branch.head ") {
            if branch_seen
                || value.is_empty()
                || value.len() > MAX_BRANCH_BYTES
                || value.chars().any(char::is_control)
            {
                return None;
            }
            branch_seen = true;
            if value == "(detached)" {
                detached = true;
            } else {
                branch = Some(value.to_string());
            }
        } else if line.starts_with("# branch.") {
            continue;
        } else if line.starts_with("1 ")
            || line.starts_with("2 ")
            || line.starts_with("u ")
            || line.starts_with("? ")
        {
            dirty = true;
        } else if line.starts_with("! ") || line.is_empty() {
            continue;
        } else {
            return None;
        }
    }
    branch_seen.then_some(RuntimeGit {
        state: RuntimeGitState::Repository,
        branch,
        detached,
        dirty,
        stale: false,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_porcelain_v2;
    use crate::protocol::{RuntimeGit, RuntimeGitState};

    #[test]
    fn parses_clean_dirty_unborn_and_detached_repositories() {
        assert_eq!(
            parse_porcelain_v2(b"# branch.oid abc\n# branch.head main\n"),
            Some(RuntimeGit {
                state: RuntimeGitState::Repository,
                branch: Some("main".to_string()),
                detached: false,
                dirty: false,
                stale: false,
            })
        );
        assert!(
            parse_porcelain_v2(b"# branch.head main\n? untracked\n")
                .unwrap()
                .dirty
        );
        let detached = parse_porcelain_v2(b"# branch.oid abc\n# branch.head (detached)\n").unwrap();
        assert!(detached.detached);
        assert_eq!(detached.branch, None);
        assert_eq!(
            parse_porcelain_v2(b"# branch.oid (initial)\n# branch.head trunk\n")
                .unwrap()
                .branch
                .as_deref(),
            Some("trunk")
        );
        assert!(parse_porcelain_v2(b"# branch.head main\ninvalid\n").is_none());
    }
}
