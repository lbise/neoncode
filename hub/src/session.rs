use std::{
    env,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};

use anyhow::{Context, Result, anyhow};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

const SESSION_EVENT_BUFFER: usize = 1024;

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Output { data_b64: String },
    Exit { status: Option<i32> },
    Error { message: String },
}

pub struct Session {
    id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    event_tx: broadcast::Sender<SessionEvent>,
}

impl Session {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        id: String,
        command: Option<String>,
        args: Vec<String>,
        cwd: Option<String>,
        rows: u16,
        cols: u16,
    ) -> Result<Self> {
        let (event_tx, _) = broadcast::channel(SESSION_EVENT_BUFFER);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open PTY")?;

        let command = command.unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&command);
        for arg in args {
            cmd.arg(arg);
        }
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }

        info!(session_id = %id, %command, rows, cols, "starting PTY session");
        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("failed to spawn command: {command}"))?;
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
        thread::Builder::new()
            .name(format!("pty-reader-{reader_session_id}"))
            .spawn(move || {
                let mut buffer = [0_u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data_b64 = BASE64.encode(&buffer[..n]);
                            if reader_event_tx
                                .send(SessionEvent::Output { data_b64 })
                                .is_err()
                            {
                                debug!(session_id = %reader_session_id, "PTY output had no subscribers");
                            }
                        }
                        Err(err) => {
                            let _ = reader_event_tx.send(SessionEvent::Error {
                                message: format!("PTY read failed: {err}"),
                            });
                            break;
                        }
                    }
                }

                let _ = reader_event_tx.send(SessionEvent::Exit { status: None });
            })
            .context("failed to spawn PTY reader thread")?;

        Ok(Self {
            id,
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
            child: Arc::new(Mutex::new(child)),
            event_tx,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.event_tx.subscribe()
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
        match self.child.lock() {
            Ok(mut child) => {
                if let Err(err) = child.kill() {
                    debug!(session_id = %self.id, %err, "failed to kill child process");
                }
            }
            Err(_) => warn!(session_id = %self.id, "child mutex poisoned while killing session"),
        }
    }
}

fn default_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| "bash".to_string())
}
