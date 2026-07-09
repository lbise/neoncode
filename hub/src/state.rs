use std::{collections::HashMap, sync::Mutex};

use anyhow::{Result, anyhow};
use tokio::sync::broadcast;
use tracing::debug;

use crate::session::{Session, SessionEvent};

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;

#[derive(Clone, Default)]
pub struct AppState {
    registry: std::sync::Arc<SessionRegistry>,
}

impl AppState {
    pub fn registry(&self) -> &SessionRegistry {
        &self.registry
    }
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
    ) -> Result<broadcast::Receiver<SessionEvent>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;

        if sessions.contains_key(&request.session_id) {
            return Err(anyhow!("session already exists: {}", request.session_id));
        }

        let session = Session::spawn(
            request.session_id.clone(),
            request.command,
            request.args.unwrap_or_default(),
            request.cwd,
            request.rows.unwrap_or(DEFAULT_ROWS),
            request.cols.unwrap_or(DEFAULT_COLS),
        )?;
        let events = session.subscribe();

        sessions.insert(
            request.session_id,
            SessionEntry {
                owner_connection_id: owner_connection_id.to_string(),
                session,
            },
        );

        Ok(events)
    }

    pub fn write_input(&self, session_id: &str, bytes: &[u8]) -> Result<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        entry.session.write_input(bytes)
    }

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        entry.session.resize(rows, cols)
    }

    pub fn kill_session(&self, session_id: &str) -> Result<()> {
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
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        let session_ids = sessions
            .iter()
            .filter(|(_, entry)| entry.owner_connection_id == owner_connection_id)
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();

        let count = session_ids.len();
        for session_id in session_ids {
            if let Some(entry) = sessions.remove(&session_id) {
                debug!(%session_id, %owner_connection_id, "killing session owned by disconnected websocket");
                entry.session.kill();
            }
        }

        Ok(count)
    }
}

pub struct StartSessionRequest {
    pub session_id: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
}

struct SessionEntry {
    owner_connection_id: String,
    session: Session,
}
