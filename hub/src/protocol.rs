use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Start {
        session_id: String,
        command: Option<String>,
        args: Option<Vec<String>>,
        cwd: Option<String>,
        rows: Option<u16>,
        cols: Option<u16>,
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
    Started {
        session_id: String,
    },
    Output {
        session_id: String,
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
