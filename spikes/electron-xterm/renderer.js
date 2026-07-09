const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:44777/ws';
const ENDPOINT = process.env.NEONCODE_HUB_ENDPOINT || DEFAULT_ENDPOINT;
const TERMINAL_COUNT = Number.parseInt(process.env.NEONCODE_TERMINAL_COUNT || '2', 10) || 2;

const encoder = new TextEncoder();
const statusElement = document.getElementById('status');
const terminalGrid = document.getElementById('terminal-grid');
const terminals = [];

function setStatus(text) {
  statusElement.textContent = text;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function sendJson(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

function buildTerminalTheme() {
  return {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#ffffff',
    selectionBackground: '#264f78',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2',
  };
}

function createPane(index) {
  const sessionId = `electron-xterm-shell-${index + 1}`;
  const container = document.getElementById(`terminal-${index + 1}`);
  if (!container) {
    return;
  }

  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'Cascadia Mono, FiraCode Nerd Font Mono, Consolas, monospace',
    fontSize: 14,
    scrollback: 10000,
    theme: buildTerminalTheme(),
    allowProposedApi: false,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  const state = {
    index,
    sessionId,
    terminal,
    fitAddon,
    socket: undefined,
    started: false,
    resizePending: false,
  };
  terminals.push(state);

  terminal.writeln('\x1b[36mNeonCode xterm.js spike\x1b[0m');
  terminal.writeln(`Connecting ${sessionId} to ${ENDPOINT}`);

  terminal.onData((data) => {
    sendJson(state.socket, {
      type: 'input',
      session_id: sessionId,
      data_b64: bytesToBase64(encoder.encode(data)),
    });
  });

  const resizeObserver = new ResizeObserver(() => scheduleFitAndResize(state));
  resizeObserver.observe(container);

  connectPane(state);
  scheduleFitAndResize(state);
}

function scheduleFitAndResize(state) {
  if (state.resizePending) {
    return;
  }

  state.resizePending = true;
  requestAnimationFrame(() => {
    state.resizePending = false;
    try {
      state.fitAddon.fit();
      if (state.started) {
        sendJson(state.socket, {
          type: 'resize',
          session_id: state.sessionId,
          rows: state.terminal.rows,
          cols: state.terminal.cols,
        });
      }
    } catch (error) {
      console.warn('fit failed', error);
    }
  });
}

function connectPane(state) {
  const socket = new WebSocket(ENDPOINT);
  state.socket = socket;

  socket.addEventListener('open', () => {
    console.log(`hub_connected ${state.index}`);
    state.started = true;
    setStatus(`Connected to ${ENDPOINT}`);
    sendJson(socket, {
      type: 'start',
      session_id: state.sessionId,
      command: 'bash',
      rows: state.terminal.rows || 30,
      cols: state.terminal.cols || 120,
    });
    scheduleFitAndResize(state);
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      state.terminal.writeln(`\r\n\x1b[31mInvalid hub JSON: ${error.message}\x1b[0m`);
      return;
    }

    if (message.type === 'output' && message.session_id === state.sessionId) {
      const bytes = base64ToBytes(message.data_b64 || '');
      console.log(`hub_output ${state.index} ${bytes.length}`);
      state.terminal.write(bytes);
    } else if (message.type === 'started' && message.session_id === state.sessionId) {
      console.log(`hub_started ${state.index}`);
      state.terminal.writeln('\r\n\x1b[32mHub session started\x1b[0m');
    } else if (message.type === 'exit' && message.session_id === state.sessionId) {
      state.terminal.writeln('\r\n\x1b[33mHub session exited\x1b[0m');
    } else if (message.type === 'error') {
      state.terminal.writeln(`\r\n\x1b[31mHub error: ${message.message}\x1b[0m`);
    }
  });

  socket.addEventListener('close', () => {
    console.log(`hub_closed ${state.index}`);
    state.started = false;
    state.terminal.writeln('\r\n\x1b[33mDisconnected from neoncode-hub\x1b[0m');
    setStatus('Disconnected from neoncode-hub');
  });

  socket.addEventListener('error', () => {
    console.log(`hub_error ${state.index}`);
    state.terminal.writeln('\r\n\x1b[31mWebSocket error. Is ./dev hub running?\x1b[0m');
    setStatus('WebSocket error');
  });
}

function configureGrid() {
  const count = Math.max(1, TERMINAL_COUNT);
  terminalGrid.style.gridTemplateColumns = `repeat(${count}, minmax(0, 1fr))`;

  for (let index = 0; index < 2; index += 1) {
    const pane = document.getElementById(`terminal-${index + 1}`)?.parentElement;
    if (pane) {
      pane.style.display = index < count ? 'grid' : 'none';
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  configureGrid();
  for (let index = 0; index < Math.min(2, Math.max(1, TERMINAL_COUNT)); index += 1) {
    createPane(index);
  }
});

window.addEventListener('beforeunload', () => {
  for (const state of terminals) {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.close();
    }
  }
});
