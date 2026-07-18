use std::{
    collections::VecDeque,
    env,
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Instant,
};

use anyhow::{Context, Result, anyhow};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

use crate::protocol::{ExitReason, ExitSummary, RuntimeCwd, RuntimeCwdState};

const SESSION_EVENT_BUFFER: usize = 4096;
const SESSION_REPLAY_BUFFER_BYTES: usize = 2 * 1024 * 1024;
const SESSION_REPLAY_BUFFER_ENTRIES: usize = 8192;

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Output {
        seq: u64,
        data_b64: String,
    },
    Exit {
        attention_id: String,
        status: Option<i32>,
        reason: ExitReason,
    },
    Error {
        message: String,
    },
}

pub struct ReplayCursor {
    pub instance_id: String,
    pub after_output_seq: u64,
}

pub struct SessionSubscription {
    pub replay: Vec<SessionEvent>,
    pub events: broadcast::Receiver<SessionEvent>,
    pub instance_id: String,
    pub first_available_seq: u64,
    pub replay_through_seq: u64,
    pub replay_truncated: bool,
    pub reset_required: bool,
}

#[derive(Default)]
struct SessionEventState {
    next_output_seq: u64,
    replay: VecDeque<ReplayEntry>,
    replay_bytes: usize,
}

struct ReplayEntry {
    event: SessionEvent,
    bytes: usize,
}

struct ReplaySelection {
    replay: Vec<SessionEvent>,
    first_available_seq: u64,
    replay_through_seq: u64,
    replay_truncated: bool,
    reset_required: bool,
}

pub struct Session {
    id: String,
    instance_id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    root_pid: Option<u32>,
    last_runtime_cwd: Mutex<Option<RuntimeCwd>>,
    running: Arc<AtomicBool>,
    kill_requested: Arc<AtomicBool>,
    outcome: Arc<Mutex<Option<ExitSummary>>>,
    completed_at: Arc<Mutex<Option<Instant>>>,
    event_tx: broadcast::Sender<SessionEvent>,
    event_state: Arc<Mutex<SessionEventState>>,
}

impl Session {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        id: String,
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
        rows: u16,
        cols: u16,
    ) -> Result<(Self, SessionSubscription)> {
        let mut instance_id_bytes = [0_u8; 16];
        getrandom::fill(&mut instance_id_bytes)
            .map_err(|error| anyhow!("failed to generate session instance id: {error}"))?;
        let instance_id = hex::encode(instance_id_bytes);
        let (event_tx, events) = broadcast::channel(SESSION_EVENT_BUFFER);
        let event_state = Arc::new(Mutex::new(SessionEventState {
            next_output_seq: 1,
            ..SessionEventState::default()
        }));

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open PTY")?;

        let mut cmd = CommandBuilder::new(&command);
        remove_control_environment(&mut cmd);
        for arg in args {
            cmd.arg(arg);
        }
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }

        info!(session_id = %id, %command, rows, cols, "starting PTY session");
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("failed to spawn command: {command}"))?;
        let root_pid = child.process_id();
        let child_killer = child.clone_killer();
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone PTY reader")?;
        let writer = pair
            .master
            .take_writer()
            .context("failed to take PTY writer")?;

        let reader_session_id = id.clone();
        let reader_event_tx = event_tx.clone();
        let reader_event_state = event_state.clone();
        let reader_thread = thread::Builder::new()
            .name(format!("pty-reader-{reader_session_id}"))
            .spawn(move || {
                let mut buffer = [0_u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            publish_output(
                                &reader_session_id,
                                &reader_event_tx,
                                &reader_event_state,
                                &buffer[..n],
                            );
                        }
                        Err(err) => {
                            publish_event(
                                &reader_session_id,
                                &reader_event_tx,
                                &reader_event_state,
                                SessionEvent::Error {
                                    message: format!("PTY read failed: {err}"),
                                },
                            );
                            break;
                        }
                    }
                }
            })
            .context("failed to spawn PTY reader thread")?;

        let mut attention_id_bytes = [0_u8; 16];
        getrandom::fill(&mut attention_id_bytes)
            .map_err(|error| anyhow!("failed to generate attention id: {error}"))?;
        let attention_id = hex::encode(attention_id_bytes);
        let running = Arc::new(AtomicBool::new(true));
        let kill_requested = Arc::new(AtomicBool::new(false));
        let outcome = Arc::new(Mutex::new(None));
        let completed_at = Arc::new(Mutex::new(None));
        let waiter_running = running.clone();
        let waiter_kill_requested = kill_requested.clone();
        let waiter_outcome = outcome.clone();
        let waiter_completed_at = completed_at.clone();
        let waiter_session_id = id.clone();
        let waiter_attention_id = attention_id;
        let waiter_event_tx = event_tx.clone();
        let waiter_event_state = event_state.clone();
        thread::Builder::new()
            .name(format!("pty-waiter-{waiter_session_id}"))
            .spawn(move || {
                let wait_result = child.wait();
                let kill_caused_exit = waiter_kill_requested.load(Ordering::Acquire);
                if reader_thread.join().is_err() {
                    publish_event(
                        &waiter_session_id,
                        &waiter_event_tx,
                        &waiter_event_state,
                        SessionEvent::Error {
                            message: "PTY reader thread panicked".to_string(),
                        },
                    );
                }

                let outcome = match wait_result {
                    Ok(exit_status) => ExitSummary {
                        attention_id: waiter_attention_id.clone(),
                        status: i32::try_from(exit_status.exit_code()).ok(),
                        reason: if kill_caused_exit {
                            ExitReason::Killed
                        } else {
                            ExitReason::ProcessExit
                        },
                    },
                    Err(err) => {
                        publish_event(
                            &waiter_session_id,
                            &waiter_event_tx,
                            &waiter_event_state,
                            SessionEvent::Error {
                                message: format!("failed to wait for PTY child: {err}"),
                            },
                        );
                        ExitSummary {
                            attention_id: waiter_attention_id.clone(),
                            status: None,
                            reason: ExitReason::WaitFailed,
                        }
                    }
                };
                if let Ok(mut stored_outcome) = waiter_outcome.lock() {
                    *stored_outcome = Some(outcome.clone());
                }
                if let Ok(mut stored_completed_at) = waiter_completed_at.lock() {
                    *stored_completed_at = Some(Instant::now());
                }
                waiter_running.store(false, Ordering::Release);
                publish_event(
                    &waiter_session_id,
                    &waiter_event_tx,
                    &waiter_event_state,
                    SessionEvent::Exit {
                        attention_id: outcome.attention_id,
                        status: outcome.status,
                        reason: outcome.reason,
                    },
                );
            })
            .context("failed to spawn PTY waiter thread")?;

        Ok((
            Self {
                id,
                instance_id: instance_id.clone(),
                writer: Arc::new(Mutex::new(writer)),
                master: Arc::new(Mutex::new(pair.master)),
                child_killer: Mutex::new(child_killer),
                root_pid,
                last_runtime_cwd: Mutex::new(None),
                running,
                kill_requested,
                outcome,
                completed_at,
                event_tx,
                event_state,
            },
            SessionSubscription {
                replay: Vec::new(),
                events,
                instance_id,
                first_available_seq: 1,
                replay_through_seq: 0,
                replay_truncated: false,
                reset_required: false,
            },
        ))
    }

    pub fn subscribe(&self, cursor: Option<ReplayCursor>) -> Result<SessionSubscription> {
        let state = self
            .event_state
            .lock()
            .map_err(|_| anyhow!("session event state mutex poisoned"))?;
        let events = self.event_tx.subscribe();
        let selection = select_replay(&state, &self.instance_id, cursor);
        Ok(SessionSubscription {
            replay: selection.replay,
            events,
            instance_id: self.instance_id.clone(),
            first_available_seq: selection.first_available_seq,
            replay_through_seq: selection.replay_through_seq,
            replay_truncated: selection.replay_truncated,
            reset_required: selection.reset_required,
        })
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn runtime_cwd(&self) -> RuntimeCwd {
        let observed = self.observe_runtime_cwd();
        if observed.state != RuntimeCwdState::Unavailable {
            if let Ok(mut last) = self.last_runtime_cwd.lock() {
                *last = Some(observed.clone());
            }
            return observed;
        }
        self.last_runtime_cwd
            .lock()
            .ok()
            .and_then(|last| last.clone())
            .map(|mut last| {
                last.stale = true;
                last
            })
            .unwrap_or(observed)
    }

    #[cfg(unix)]
    fn observe_runtime_cwd(&self) -> RuntimeCwd {
        let root_pid = self.root_pid;
        let root_session = root_pid.and_then(proc_session_id);
        let foreground_group = self
            .master
            .lock()
            .ok()
            .and_then(|master| master.process_group_leader())
            .and_then(|pid| u32::try_from(pid).ok());
        let descendants = match (root_pid, root_session, foreground_group) {
            (Some(root_pid), Some(root_session), Some(foreground_group)) => {
                foreground_descendants(root_pid, root_session, foreground_group)
            }
            _ => Vec::new(),
        };
        let foreground_leader = foreground_group
            .filter(|pid| root_session.is_some() && proc_session_id(*pid) == root_session);
        for pid in descendants
            .into_iter()
            .rev()
            .chain(foreground_leader)
            .chain(root_pid)
        {
            if let Ok(path) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
                let Some(mut path) = path.to_str().map(str::to_string) else {
                    continue;
                };
                let state = if path.ends_with(" (deleted)") {
                    path.truncate(path.len() - " (deleted)".len());
                    RuntimeCwdState::Deleted
                } else {
                    RuntimeCwdState::Current
                };
                return RuntimeCwd {
                    path: Some(path),
                    state,
                    stale: false,
                };
            }
        }
        unavailable_runtime_cwd()
    }

    #[cfg(not(unix))]
    fn observe_runtime_cwd(&self) -> RuntimeCwd {
        unavailable_runtime_cwd()
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn outcome(&self) -> Option<ExitSummary> {
        self.outcome.lock().ok().and_then(|outcome| outcome.clone())
    }

    pub fn completed_at(&self) -> Option<Instant> {
        self.completed_at
            .lock()
            .ok()
            .and_then(|completed_at| *completed_at)
    }

    pub fn write_input(&self, bytes: &[u8]) -> Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| anyhow!("PTY writer mutex poisoned"))?;
        writer
            .write_all(bytes)
            .context("failed to write PTY input")?;
        writer.flush().context("failed to flush PTY input")?;
        Ok(())
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        let master = self
            .master
            .lock()
            .map_err(|_| anyhow!("PTY master mutex poisoned"))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to resize PTY")?;
        Ok(())
    }

    pub fn kill(self) {
        self.kill_requested.store(true, Ordering::Release);
        match self.child_killer.lock() {
            Ok(mut child_killer) => {
                if let Err(err) = child_killer.kill() {
                    debug!(session_id = %self.id, %err, "failed to kill child process");
                }
            }
            Err(_) => warn!(session_id = %self.id, "child mutex poisoned while killing session"),
        }
    }
}

fn unavailable_runtime_cwd() -> RuntimeCwd {
    RuntimeCwd {
        path: None,
        state: RuntimeCwdState::Unavailable,
        stale: false,
    }
}

#[cfg(unix)]
fn proc_session_id(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_proc_fields(&stat).map(|fields| fields.1)
}

#[cfg(unix)]
fn foreground_descendants(root_pid: u32, root_session: u32, foreground_group: u32) -> Vec<u32> {
    const MAX_DESCENDANTS: usize = 256;
    const MAX_CHILD_LIST_BYTES: usize = 64 * 1024;
    let mut queue = VecDeque::from([root_pid]);
    let mut candidates = Vec::new();
    let mut child_list_bytes = 0;
    while let Some(pid) = queue.pop_front() {
        if queue.len() + candidates.len() >= MAX_DESCENDANTS {
            break;
        }
        let Ok(children) = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        else {
            continue;
        };
        child_list_bytes += children.len();
        if child_list_bytes > MAX_CHILD_LIST_BYTES {
            break;
        }
        for child in children
            .split_whitespace()
            .filter_map(|value| value.parse().ok())
        {
            if queue.len() + candidates.len() >= MAX_DESCENDANTS {
                break;
            }
            let Some((process_group, session)) =
                std::fs::read_to_string(format!("/proc/{child}/stat"))
                    .ok()
                    .and_then(|stat| parse_proc_fields(&stat))
            else {
                continue;
            };
            if session != root_session {
                continue;
            }
            queue.push_back(child);
            if process_group == foreground_group {
                candidates.push(child);
            }
        }
    }
    candidates
}

#[cfg(unix)]
fn parse_proc_fields(stat: &str) -> Option<(u32, u32)> {
    let command_end = stat.rfind(") ")?;
    let mut fields = stat.get(command_end + 2..)?.split_whitespace();
    fields.next()?;
    fields.next()?;
    let process_group = fields.next()?.parse().ok()?;
    let session = fields.next()?.parse().ok()?;
    Some((process_group, session))
}

#[cfg(all(unix, test))]
fn parse_proc_session_id(stat: &str) -> Option<u32> {
    parse_proc_fields(stat).map(|fields| fields.1)
}

fn select_replay(
    state: &SessionEventState,
    instance_id: &str,
    cursor: Option<ReplayCursor>,
) -> ReplaySelection {
    let first_available_seq = state
        .replay
        .front()
        .and_then(|entry| output_seq(&entry.event))
        .unwrap_or(state.next_output_seq);
    let replay_through_seq = state.next_output_seq.saturating_sub(1);
    let (reset_required, replay_truncated, after_output_seq) = match cursor {
        None => (false, false, None),
        Some(cursor)
            if cursor.instance_id != instance_id
                || cursor.after_output_seq > replay_through_seq =>
        {
            (true, false, None)
        }
        Some(cursor) if cursor.after_output_seq.saturating_add(1) < first_available_seq => {
            (false, true, None)
        }
        Some(cursor) => (false, false, Some(cursor.after_output_seq)),
    };
    let replay = state
        .replay
        .iter()
        .filter(|entry| {
            after_output_seq
                .is_none_or(|after| output_seq(&entry.event).is_some_and(|seq| seq > after))
        })
        .map(|entry| entry.event.clone())
        .collect();
    ReplaySelection {
        replay,
        first_available_seq,
        replay_through_seq,
        replay_truncated,
        reset_required,
    }
}

fn output_seq(event: &SessionEvent) -> Option<u64> {
    match event {
        SessionEvent::Output { seq, .. } => Some(*seq),
        _ => None,
    }
}

fn publish_output(
    session_id: &str,
    event_tx: &broadcast::Sender<SessionEvent>,
    event_state: &Mutex<SessionEventState>,
    bytes: &[u8],
) {
    let mut state = match event_state.lock() {
        Ok(state) => state,
        Err(_) => {
            warn!(%session_id, "session event state mutex poisoned while publishing output");
            return;
        }
    };

    let event = SessionEvent::Output {
        seq: state.next_output_seq,
        data_b64: BASE64.encode(bytes),
    };
    state.next_output_seq += 1;
    state.replay_bytes += bytes.len();
    state.replay.push_back(ReplayEntry {
        event: event.clone(),
        bytes: bytes.len(),
    });
    while state.replay_bytes > SESSION_REPLAY_BUFFER_BYTES
        || state.replay.len() > SESSION_REPLAY_BUFFER_ENTRIES
    {
        if let Some(entry) = state.replay.pop_front() {
            state.replay_bytes -= entry.bytes;
        } else {
            break;
        }
    }

    if event_tx.send(event).is_err() {
        debug!(%session_id, "PTY output had no live subscribers; retained for replay");
    }
}

fn publish_event(
    session_id: &str,
    event_tx: &broadcast::Sender<SessionEvent>,
    event_state: &Mutex<SessionEventState>,
    event: SessionEvent,
) {
    let _state = match event_state.lock() {
        Ok(state) => state,
        Err(_) => {
            warn!(%session_id, "session event state mutex poisoned while publishing event");
            return;
        }
    };
    let _ = event_tx.send(event);
}

fn remove_control_environment(command: &mut CommandBuilder) {
    command.env_remove("NEONCODE_HUB_TOKEN");
}

pub(crate) fn default_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| "bash".to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use portable_pty::CommandBuilder;
    use tokio::sync::broadcast;

    use super::{
        ReplayCursor, SESSION_REPLAY_BUFFER_ENTRIES, SessionEventState, parse_proc_session_id,
        publish_output, remove_control_environment, select_replay,
    };

    #[test]
    fn proc_stat_parser_handles_spaces_and_parentheses_in_command() {
        assert_eq!(
            parse_proc_session_id("123 (command with ) spaces) S 10 123 77 0 0 0 0 0"),
            Some(77)
        );
        assert_eq!(parse_proc_session_id("malformed"), None);
    }

    #[test]
    fn capability_token_is_removed_from_child_environment() {
        let mut command = CommandBuilder::new("sh");
        command.env("NEONCODE_HUB_TOKEN", "secret");

        remove_control_environment(&mut command);

        assert!(command.get_env("NEONCODE_HUB_TOKEN").is_none());
    }

    #[test]
    fn replay_checkpoint_reports_truncation_and_instance_reset() {
        let (events, _receiver) = broadcast::channel(1);
        let state = Mutex::new(SessionEventState {
            next_output_seq: 1,
            ..SessionEventState::default()
        });
        for _ in 0..(SESSION_REPLAY_BUFFER_ENTRIES + 100) {
            publish_output("checkpoint", &events, &state, b"x");
        }
        let state = state.lock().unwrap();
        let truncated = select_replay(
            &state,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            Some(ReplayCursor {
                instance_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
                after_output_seq: 0,
            }),
        );
        assert!(truncated.replay_truncated);
        assert!(!truncated.reset_required);
        assert!(truncated.first_available_seq > 1);
        assert_eq!(truncated.replay.len(), SESSION_REPLAY_BUFFER_ENTRIES);

        let reset = select_replay(
            &state,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            Some(ReplayCursor {
                instance_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
                after_output_seq: truncated.replay_through_seq,
            }),
        );
        assert!(reset.reset_required);
        assert!(!reset.replay_truncated);
        assert_eq!(reset.replay.len(), SESSION_REPLAY_BUFFER_ENTRIES);
    }

    #[test]
    fn replay_is_bounded_by_entry_count() {
        let (events, _receiver) = broadcast::channel(1);
        let state = Mutex::new(SessionEventState {
            next_output_seq: 1,
            ..SessionEventState::default()
        });

        for _ in 0..(SESSION_REPLAY_BUFFER_ENTRIES + 100) {
            publish_output("bounded-replay", &events, &state, b"x");
        }

        assert_eq!(
            state.lock().unwrap().replay.len(),
            SESSION_REPLAY_BUFFER_ENTRIES
        );
    }
}
