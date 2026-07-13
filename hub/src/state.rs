use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use anyhow::{Result, anyhow};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tracing::debug;

use crate::{
    protocol::SessionSummary,
    session::{Session, SessionSubscription},
};

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const MAX_SESSIONS: usize = 64;
const MAX_SESSION_ID_BYTES: usize = 128;
const MAX_COMMAND_BYTES: usize = 4096;
const MAX_ARGUMENTS: usize = 128;
const MAX_ARGUMENT_BYTES: usize = 4096;
const MAX_CWD_BYTES: usize = 4096;
const MAX_TERMINAL_DIMENSION: u16 = 1000;
const MAX_WEBSOCKET_CONNECTIONS: usize = 128;

#[derive(Clone)]
pub struct AppState {
    registry: Arc<SessionRegistry>,
    capability_token: Arc<str>,
    websocket_connections: Arc<Semaphore>,
}

impl AppState {
    pub fn new(capability_token: String) -> Result<Self> {
        validate_capability_token(&capability_token)?;
        Ok(Self {
            registry: Arc::new(SessionRegistry::default()),
            capability_token: capability_token.into(),
            websocket_connections: Arc::new(Semaphore::new(MAX_WEBSOCKET_CONNECTIONS)),
        })
    }

    pub fn registry(&self) -> &SessionRegistry {
        &self.registry
    }

    pub fn capability_token(&self) -> &str {
        &self.capability_token
    }

    pub fn try_acquire_websocket(&self) -> Result<OwnedSemaphorePermit> {
        self.websocket_connections
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow!("websocket connection limit reached"))
    }
}

pub fn validate_capability_token(token: &str) -> Result<()> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(anyhow!(
            "hub capability token must contain exactly 64 hexadecimal characters"
        ));
    }
    Ok(())
}

#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, SessionEntry>>,
}

impl SessionRegistry {
    pub fn start_session(
        &self,
        owner_connection_id: &str,
        request: StartSessionRequest,
    ) -> Result<SessionSubscription> {
        request.validate()?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        prune_exited_sessions(&mut sessions);

        if sessions.contains_key(&request.session_id) {
            return Err(anyhow!("session already exists: {}", request.session_id));
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err(anyhow!("session limit reached"));
        }

        let (session, events) = Session::spawn(
            request.session_id.clone(),
            request.command,
            request.args.unwrap_or_default(),
            request.cwd,
            request.rows.unwrap_or(DEFAULT_ROWS),
            request.cols.unwrap_or(DEFAULT_COLS),
        )?;

        sessions.insert(
            request.session_id,
            SessionEntry {
                owner_connection_id: Some(owner_connection_id.to_string()),
                session,
            },
        );

        Ok(events)
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionSummary>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        prune_exited_sessions(&mut sessions);

        let mut summaries = sessions
            .keys()
            .map(|session_id| SessionSummary {
                session_id: session_id.clone(),
            })
            .collect::<Vec<_>>();
        summaries.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        Ok(summaries)
    }

    pub fn subscribe_session(&self, session_id: &str) -> Result<SessionSubscription> {
        validate_session_id(session_id)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        prune_exited_sessions(&mut sessions);

        let entry = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        entry.session.subscribe()
    }

    pub fn release_owner_if_matches(
        &self,
        session_id: &str,
        owner_connection_id: &str,
    ) -> Result<()> {
        validate_session_id(session_id)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        prune_exited_sessions(&mut sessions);

        let entry = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;

        if entry.owner_connection_id.as_deref() == Some(owner_connection_id) {
            debug!(%session_id, %owner_connection_id, "detaching session from owning websocket");
            entry.owner_connection_id = None;
        }

        Ok(())
    }

    pub fn write_input(&self, session_id: &str, bytes: &[u8]) -> Result<()> {
        validate_session_id(session_id)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        prune_exited_sessions(&mut sessions);

        let entry = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        entry.session.write_input(bytes)
    }

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<()> {
        validate_session_id(session_id)?;
        validate_terminal_size(rows, cols)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        prune_exited_sessions(&mut sessions);

        let entry = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        entry.session.resize(rows, cols)
    }

    pub fn kill_session(&self, session_id: &str) -> Result<()> {
        validate_session_id(session_id)?;
        let entry = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?
            .remove(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        entry.session.kill();
        Ok(())
    }

    pub fn kill_sessions_for_connection(&self, owner_connection_id: &str) -> Result<usize> {
        let entries = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("session registry mutex poisoned"))?;
            let session_ids = sessions
                .iter()
                .filter(|(_, entry)| {
                    entry.owner_connection_id.as_deref() == Some(owner_connection_id)
                })
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();

            session_ids
                .into_iter()
                .filter_map(|session_id| {
                    sessions.remove(&session_id).inspect(|_| {
                        debug!(%session_id, %owner_connection_id, "killing session owned by disconnected websocket");
                    })
                })
                .collect::<Vec<_>>()
        };

        let count = entries.len();
        for entry in entries {
            entry.session.kill();
        }
        Ok(count)
    }
}

fn prune_exited_sessions(sessions: &mut HashMap<String, SessionEntry>) {
    sessions.retain(|session_id, entry| {
        let running = entry.session.is_running();
        if !running {
            debug!(%session_id, "removing exited session from registry");
        }
        running
    });
}

pub(crate) fn validate_session_id(session_id: &str) -> Result<()> {
    if session_id.is_empty()
        || session_id.len() > MAX_SESSION_ID_BYTES
        || !session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err(anyhow!(
            "session_id must contain 1-{MAX_SESSION_ID_BYTES} ASCII letters, digits, '.', '_', or '-'"
        ));
    }
    Ok(())
}

fn validate_terminal_size(rows: u16, cols: u16) -> Result<()> {
    if rows == 0 || cols == 0 || rows > MAX_TERMINAL_DIMENSION || cols > MAX_TERMINAL_DIMENSION {
        return Err(anyhow!(
            "terminal size must be between 1 and {MAX_TERMINAL_DIMENSION} rows/cols"
        ));
    }
    Ok(())
}

pub struct StartSessionRequest {
    pub session_id: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
}

impl StartSessionRequest {
    fn validate(&self) -> Result<()> {
        validate_session_id(&self.session_id)?;

        if self
            .command
            .as_ref()
            .is_some_and(|command| command.len() > MAX_COMMAND_BYTES)
        {
            return Err(anyhow!("command exceeds {MAX_COMMAND_BYTES} bytes"));
        }

        if self
            .cwd
            .as_ref()
            .is_some_and(|cwd| cwd.len() > MAX_CWD_BYTES)
        {
            return Err(anyhow!("cwd exceeds {MAX_CWD_BYTES} bytes"));
        }

        if let Some(args) = &self.args {
            if args.len() > MAX_ARGUMENTS {
                return Err(anyhow!("argument count exceeds {MAX_ARGUMENTS}"));
            }
            if args
                .iter()
                .any(|argument| argument.len() > MAX_ARGUMENT_BYTES)
            {
                return Err(anyhow!("argument exceeds {MAX_ARGUMENT_BYTES} bytes"));
            }
        }

        validate_terminal_size(
            self.rows.unwrap_or(DEFAULT_ROWS),
            self.cols.unwrap_or(DEFAULT_COLS),
        )
    }
}

struct SessionEntry {
    owner_connection_id: Option<String>,
    session: Session,
}

#[cfg(test)]
mod tests {
    use super::{AppState, MAX_WEBSOCKET_CONNECTIONS};

    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn websocket_connection_count_is_bounded() {
        let state = AppState::new(TEST_TOKEN.to_string()).unwrap();
        let permits = (0..MAX_WEBSOCKET_CONNECTIONS)
            .map(|_| state.try_acquire_websocket().unwrap())
            .collect::<Vec<_>>();

        assert!(state.try_acquire_websocket().is_err());
        drop(permits);
        assert!(state.try_acquire_websocket().is_ok());
    }
}
