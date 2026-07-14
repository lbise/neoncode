use std::{
    collections::VecDeque,
    env,
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use anyhow::{Context, Result, anyhow};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

const SESSION_EVENT_BUFFER: usize = 256;
const SESSION_REPLAY_BUFFER_BYTES: usize = 2 * 1024 * 1024;
const SESSION_REPLAY_BUFFER_ENTRIES: usize = 4096;

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Output { seq: u64, data_b64: String },
    Exit { status: Option<i32> },
    Error { message: String },
}

pub struct SessionSubscription {
    pub replay: Vec<SessionEvent>,
    pub events: broadcast::Receiver<SessionEvent>,
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

pub struct Session {
    id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    running: Arc<AtomicBool>,
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

        let running = Arc::new(AtomicBool::new(true));
        let waiter_running = running.clone();
        let waiter_session_id = id.clone();
        let waiter_event_tx = event_tx.clone();
        let waiter_event_state = event_state.clone();
        thread::Builder::new()
            .name(format!("pty-waiter-{waiter_session_id}"))
            .spawn(move || {
                let wait_result = child.wait();
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

                waiter_running.store(false, Ordering::Release);
                match wait_result {
                    Ok(exit_status) => {
                        let status = i32::try_from(exit_status.exit_code()).ok();
                        publish_event(
                            &waiter_session_id,
                            &waiter_event_tx,
                            &waiter_event_state,
                            SessionEvent::Exit { status },
                        );
                    }
                    Err(err) => {
                        publish_event(
                            &waiter_session_id,
                            &waiter_event_tx,
                            &waiter_event_state,
                            SessionEvent::Error {
                                message: format!("failed to wait for PTY child: {err}"),
                            },
                        );
                        publish_event(
                            &waiter_session_id,
                            &waiter_event_tx,
                            &waiter_event_state,
                            SessionEvent::Exit { status: None },
                        );
                    }
                }
            })
            .context("failed to spawn PTY waiter thread")?;

        Ok((
            Self {
                id,
                writer: Arc::new(Mutex::new(writer)),
                master: Arc::new(Mutex::new(pair.master)),
                child_killer: Mutex::new(child_killer),
                running,
                event_tx,
                event_state,
            },
            SessionSubscription {
                replay: Vec::new(),
                events,
            },
        ))
    }

    pub fn subscribe(&self) -> Result<SessionSubscription> {
        let state = self
            .event_state
            .lock()
            .map_err(|_| anyhow!("session event state mutex poisoned"))?;
        let events = self.event_tx.subscribe();
        let replay = state
            .replay
            .iter()
            .map(|entry| entry.event.clone())
            .collect();
        Ok(SessionSubscription { replay, events })
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
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
        SESSION_REPLAY_BUFFER_ENTRIES, SessionEventState, publish_output,
        remove_control_environment,
    };

    #[test]
    fn capability_token_is_removed_from_child_environment() {
        let mut command = CommandBuilder::new("sh");
        command.env("NEONCODE_HUB_TOKEN", "secret");

        remove_control_environment(&mut command);

        assert!(command.get_env("NEONCODE_HUB_TOKEN").is_none());
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
