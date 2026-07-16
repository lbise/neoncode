use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Authenticate {
        client_nonce: String,
        hmac: String,
    },
    Start {
        session_id: String,
        command: Option<String>,
        args: Option<Vec<String>>,
        cwd: Option<String>,
        rows: Option<u16>,
        cols: Option<u16>,
        #[serde(default)]
        persistent: bool,
    },
    ListSessions,
    Attach {
        session_id: String,
        instance_id: Option<String>,
        after_output_seq: Option<u64>,
    },
    Detach {
        session_id: String,
    },
    Input {
        session_id: String,
        data_b64: String,
    },
    Resize {
        session_id: String,
        rows: u16,
        cols: u16,
    },
    Kill {
        session_id: String,
    },
    AcknowledgeAttention {
        session_id: String,
        attention_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    AuthChallenge {
        nonce: String,
    },
    Authenticated {
        hmac: String,
    },
    Welcome {
        protocol_version: u32,
        boot_id: String,
        capabilities: Vec<String>,
    },
    Started {
        session_id: String,
        instance_id: String,
    },
    SessionList {
        sessions: Vec<SessionSummary>,
    },
    Attached {
        session_id: String,
        instance_id: String,
        first_available_seq: u64,
        replay_through_seq: u64,
        replay_truncated: bool,
        reset_required: bool,
    },
    Detached {
        session_id: String,
    },
    Output {
        session_id: String,
        seq: u64,
        data_b64: String,
    },
    Exit {
        session_id: String,
        attention_id: String,
        status: Option<i32>,
        reason: ExitReason,
    },
    Killed {
        session_id: String,
    },
    AttentionAcknowledged {
        session_id: String,
        attention_id: String,
    },
    Error {
        session_id: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    ProcessExit,
    WaitFailed,
    Killed,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeCwdState {
    Current,
    Deleted,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RuntimeCwd {
    pub path: Option<String>,
    pub state: RuntimeCwdState,
    pub stale: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Running,
    Exited,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExitSummary {
    pub attention_id: String,
    pub status: Option<i32>,
    pub reason: ExitReason,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub instance_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub runtime_cwd: RuntimeCwd,
    pub persistent: bool,
    pub attachment_count: u32,
    pub state: SessionState,
    pub latest_exit: Option<ExitSummary>,
}
