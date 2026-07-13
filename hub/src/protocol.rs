use serde::{Deserialize, Serialize};

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
    },
    ListSessions,
    Attach {
        session_id: String,
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
    Started {
        session_id: String,
    },
    SessionList {
        sessions: Vec<SessionSummary>,
    },
    Attached {
        session_id: String,
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
        status: Option<i32>,
    },
    Killed {
        session_id: String,
    },
    Error {
        session_id: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub session_id: String,
}
