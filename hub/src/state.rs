use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Instant,
};

use anyhow::{Result, anyhow};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tracing::debug;

use crate::{
    protocol::{ExitSummary, SessionState, SessionSummary},
    session::{ReplayCursor, Session, SessionSubscription, default_shell},
};

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const MAX_SESSIONS: usize = 64;
const MAX_RETAINED_EXITS: usize = 64;
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
    boot_id: Arc<str>,
    websocket_connections: Arc<Semaphore>,
}

impl AppState {
    pub fn new(capability_token: String) -> Result<Self> {
        validate_capability_token(&capability_token)?;
        let mut boot_id = [0_u8; 32];
        getrandom::fill(&mut boot_id)
            .map_err(|error| anyhow!("failed to generate boot id: {error}"))?;
        Ok(Self {
            registry: Arc::new(SessionRegistry::default()),
            capability_token: capability_token.into(),
            boot_id: hex::encode(boot_id).into(),
            websocket_connections: Arc::new(Semaphore::new(MAX_WEBSOCKET_CONNECTIONS)),
        })
    }

    pub fn registry(&self) -> &SessionRegistry {
        &self.registry
    }

    pub fn capability_token(&self) -> &str {
        &self.capability_token
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
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
    retained_exits: Mutex<RetainedExitState>,
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
        self.prune_exited_sessions(&mut sessions)?;

        if sessions.contains_key(&request.session_id) {
            return Err(anyhow!("session already exists: {}", request.session_id));
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err(anyhow!("session limit reached"));
        }
        self.make_room_for_active_session(&sessions, &request.session_id)?;

        let command = request.command.unwrap_or_else(default_shell);
        let cwd = request.cwd;
        let (session, events) = Session::spawn(
            request.session_id.clone(),
            command.clone(),
            request.args.unwrap_or_default(),
            cwd.clone(),
            request.rows.unwrap_or(DEFAULT_ROWS),
            request.cols.unwrap_or(DEFAULT_COLS),
        )?;

        sessions.insert(
            request.session_id,
            SessionEntry {
                owner_connection_id: (!request.persistent).then(|| owner_connection_id.to_string()),
                persistent: request.persistent,
                command,
                cwd,
                attachments: HashSet::from([owner_connection_id.to_string()]),
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
        self.prune_exited_sessions(&mut sessions)?;

        let retained = self
            .retained_exits
            .lock()
            .map_err(|_| anyhow!("retained exit mutex poisoned"))?;
        let mut summaries = sessions
            .iter()
            .map(|(session_id, entry)| SessionSummary {
                session_id: session_id.clone(),
                instance_id: entry.session.instance_id().to_string(),
                command: entry.command.clone(),
                cwd: entry.cwd.clone(),
                persistent: entry.persistent,
                attachment_count: u32::try_from(entry.attachments.len()).unwrap_or(u32::MAX),
                state: SessionState::Running,
                latest_exit: retained
                    .records
                    .get(session_id)
                    .map(|record| record.outcome.clone()),
            })
            .collect::<Vec<_>>();
        summaries.extend(
            retained
                .records
                .iter()
                .filter(|(session_id, _)| !sessions.contains_key(*session_id))
                .map(|(session_id, record)| SessionSummary {
                    session_id: session_id.clone(),
                    instance_id: record.instance_id.clone(),
                    command: record.command.clone(),
                    cwd: record.cwd.clone(),
                    persistent: record.persistent,
                    attachment_count: 0,
                    state: SessionState::Exited,
                    latest_exit: Some(record.outcome.clone()),
                }),
        );
        summaries.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        Ok(summaries)
    }

    pub fn subscribe_session(
        &self,
        session_id: &str,
        connection_id: &str,
        cursor: Option<ReplayCursor>,
    ) -> Result<SessionSubscription> {
        validate_session_id(session_id)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        self.prune_exited_sessions(&mut sessions)?;

        let entry = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        if entry.attachments.contains(connection_id) {
            return Err(anyhow!(
                "session already attached by this connection: {session_id}"
            ));
        }
        let subscription = entry.session.subscribe(cursor)?;
        entry.attachments.insert(connection_id.to_string());
        Ok(subscription)
    }

    pub fn remove_attachment(&self, session_id: &str, connection_id: &str) -> Result<()> {
        validate_session_id(session_id)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        self.prune_exited_sessions(&mut sessions)?;

        let entry = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        if !entry.attachments.remove(connection_id) {
            return Err(anyhow!(
                "session is not attached by this connection: {session_id}"
            ));
        }
        Ok(())
    }

    pub fn detach_session(&self, session_id: &str, owner_connection_id: &str) -> Result<()> {
        validate_session_id(session_id)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        self.prune_exited_sessions(&mut sessions)?;

        let entry = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;

        if !entry.attachments.remove(owner_connection_id) {
            return Err(anyhow!(
                "session is not attached by this connection: {session_id}"
            ));
        }
        if entry.owner_connection_id.as_deref() == Some(owner_connection_id) {
            debug!(%session_id, %owner_connection_id, "detaching session from owning websocket");
            entry.owner_connection_id = None;
            entry.persistent = true;
        }

        Ok(())
    }

    pub fn write_input(&self, session_id: &str, bytes: &[u8]) -> Result<()> {
        validate_session_id(session_id)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("session registry mutex poisoned"))?;
        self.prune_exited_sessions(&mut sessions)?;

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
        self.prune_exited_sessions(&mut sessions)?;

        let entry = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        entry.session.resize(rows, cols)
    }

    pub fn kill_session(&self, session_id: &str) -> Result<()> {
        validate_session_id(session_id)?;
        let entry = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("session registry mutex poisoned"))?;
            self.prune_exited_sessions(&mut sessions)?;
            sessions
                .remove(session_id)
                .ok_or_else(|| anyhow!("unknown running session: {session_id}"))?
        };
        entry.session.kill();
        Ok(())
    }

    pub fn acknowledge_attention(&self, session_id: &str, attention_id: &str) -> Result<()> {
        validate_session_id(session_id)?;
        validate_attention_id(attention_id)?;
        let mut retained = self
            .retained_exits
            .lock()
            .map_err(|_| anyhow!("retained exit mutex poisoned"))?;
        let Some(record) = retained.records.get(session_id) else {
            return Ok(());
        };
        if record.outcome.attention_id != attention_id {
            return Err(anyhow!(
                "retained attention changed for session: {session_id}"
            ));
        }
        retained.records.remove(session_id);
        retained.record_ids.remove(session_id);
        Ok(())
    }

    pub fn kill_sessions_for_connection(&self, owner_connection_id: &str) -> Result<usize> {
        let entries = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("session registry mutex poisoned"))?;
            self.prune_exited_sessions(&mut sessions)?;
            for entry in sessions.values_mut() {
                entry.attachments.remove(owner_connection_id);
            }
            let session_ids = sessions
                .iter()
                .filter(|(_, entry)| {
                    !entry.persistent
                        && entry.owner_connection_id.as_deref() == Some(owner_connection_id)
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

    fn make_room_for_active_session(
        &self,
        sessions: &HashMap<String, SessionEntry>,
        new_session_id: &str,
    ) -> Result<()> {
        let mut retained = self
            .retained_exits
            .lock()
            .map_err(|_| anyhow!("retained exit mutex poisoned"))?;
        loop {
            let distinct_retained = retained
                .records
                .keys()
                .filter(|session_id| !sessions.contains_key(*session_id))
                .count();
            let additional = usize::from(!retained.records.contains_key(new_session_id));
            if sessions.len() + distinct_retained + additional <= MAX_SESSIONS {
                return Ok(());
            }
            if !retained.evict_oldest() {
                return Err(anyhow!("session and retained attention limit reached"));
            }
        }
    }

    fn prune_exited_sessions(&self, sessions: &mut HashMap<String, SessionEntry>) -> Result<()> {
        let mut exited_ids = sessions
            .iter()
            .filter(|(_, entry)| !entry.session.is_running())
            .map(|(session_id, entry)| {
                (
                    entry.session.completed_at().unwrap_or_else(Instant::now),
                    session_id.clone(),
                )
            })
            .collect::<Vec<_>>();
        exited_ids.sort_by_key(|(completed_at, _)| *completed_at);
        if exited_ids.is_empty() {
            return Ok(());
        }

        let mut retained = self
            .retained_exits
            .lock()
            .map_err(|_| anyhow!("retained exit mutex poisoned"))?;
        for (_, session_id) in exited_ids {
            let Some(entry) = sessions.remove(&session_id) else {
                continue;
            };
            let Some(outcome) = entry.session.outcome() else {
                continue;
            };
            debug!(%session_id, "retaining exited session attention");
            retained.insert(
                session_id,
                RetainedExitRecord {
                    instance_id: entry.session.instance_id().to_string(),
                    command: entry.command,
                    cwd: entry.cwd,
                    persistent: entry.persistent,
                    outcome,
                },
            );
        }
        Ok(())
    }
}

fn validate_attention_id(attention_id: &str) -> Result<()> {
    if attention_id.len() != 32 || !attention_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(anyhow!(
            "attention_id must contain exactly 32 hexadecimal characters"
        ));
    }
    Ok(())
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
    pub persistent: bool,
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
    persistent: bool,
    command: String,
    cwd: Option<String>,
    attachments: HashSet<String>,
    session: Session,
}

struct RetainedExitRecord {
    instance_id: String,
    command: String,
    cwd: Option<String>,
    persistent: bool,
    outcome: ExitSummary,
}

#[derive(Default)]
struct RetainedExitState {
    records: HashMap<String, RetainedExitRecord>,
    order: VecDeque<(u64, String)>,
    next_record_id: u64,
    record_ids: HashMap<String, u64>,
}

impl RetainedExitState {
    fn evict_oldest(&mut self) -> bool {
        while let Some((old_record_id, old_session_id)) = self.order.pop_front() {
            if self.record_ids.get(&old_session_id) == Some(&old_record_id) {
                self.record_ids.remove(&old_session_id);
                self.records.remove(&old_session_id);
                return true;
            }
        }
        false
    }

    fn insert(&mut self, session_id: String, record: RetainedExitRecord) {
        let record_id = self.next_record_id;
        self.next_record_id = self.next_record_id.wrapping_add(1);
        self.records.insert(session_id.clone(), record);
        self.record_ids.insert(session_id.clone(), record_id);
        self.order
            .retain(|(_, queued_session_id)| queued_session_id != &session_id);
        self.order.push_back((record_id, session_id));

        while self.records.len() > MAX_RETAINED_EXITS && self.evict_oldest() {}
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::protocol::{ExitReason, ExitSummary};

    use super::{
        AppState, MAX_RETAINED_EXITS, MAX_WEBSOCKET_CONNECTIONS, RetainedExitRecord,
        RetainedExitState, SessionRegistry,
    };

    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn retained_exits_are_bounded_and_replace_by_session_id() {
        let mut retained = RetainedExitState::default();
        for index in 0..(MAX_RETAINED_EXITS + 10) {
            retained.insert(
                format!("session-{index}"),
                RetainedExitRecord {
                    instance_id: format!("{index:032x}"),
                    command: "sh".to_string(),
                    cwd: None,
                    persistent: true,
                    outcome: ExitSummary {
                        attention_id: format!("{index:032x}"),
                        status: Some(index as i32),
                        reason: ExitReason::ProcessExit,
                    },
                },
            );
        }
        assert_eq!(retained.records.len(), MAX_RETAINED_EXITS);
        assert!(!retained.records.contains_key("session-0"));
        retained.insert(
            "session-10".to_string(),
            RetainedExitRecord {
                instance_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_string(),
                command: "bash".to_string(),
                cwd: Some("/tmp".to_string()),
                persistent: true,
                outcome: ExitSummary {
                    attention_id: "ffffffffffffffffffffffffffffffff".to_string(),
                    status: Some(99),
                    reason: ExitReason::ProcessExit,
                },
            },
        );
        assert_eq!(retained.records.len(), MAX_RETAINED_EXITS);
        assert!(retained.order.len() <= MAX_RETAINED_EXITS);
        assert_eq!(retained.records["session-10"].outcome.status, Some(99));
    }

    #[test]
    fn new_active_session_evicts_attention_to_preserve_summary_bound() {
        let registry = SessionRegistry::default();
        {
            let mut retained = registry.retained_exits.lock().unwrap();
            for index in 0..MAX_RETAINED_EXITS {
                retained.insert(
                    format!("retained-{index}"),
                    RetainedExitRecord {
                        instance_id: format!("{index:032x}"),
                        command: "sh".to_string(),
                        cwd: None,
                        persistent: true,
                        outcome: ExitSummary {
                            attention_id: format!("{index:032x}"),
                            status: Some(0),
                            reason: ExitReason::ProcessExit,
                        },
                    },
                );
            }
        }
        registry
            .make_room_for_active_session(&HashMap::new(), "new-session")
            .unwrap();
        assert_eq!(
            registry.retained_exits.lock().unwrap().records.len(),
            MAX_RETAINED_EXITS - 1
        );
    }

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
