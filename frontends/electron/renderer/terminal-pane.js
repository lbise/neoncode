const { clipboard } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const { HubClient, base64ToBytes, decoder, encoder } = require('./hub-client');

function normalizeTerminalText(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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

class TerminalPane {
  constructor({ index, paneId, sessionKey, sessionId, endpoint, container, sessionModel, setStatus }) {
    this.index = index;
    this.paneId = paneId;
    this.sessionKey = sessionKey;
    this.sessionId = sessionId;
    this.endpoint = endpoint;
    this.container = container;
    this.sessionModel = sessionModel;
    this.setStatus = setStatus;
    this.state = undefined;
    this.hubClient = undefined;
    this.resizeObserver = undefined;
  }

  start() {
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
    terminal.open(this.container);

    this.state = this.sessionModel.createPaneState({
      index: this.index,
      paneId: this.paneId,
      sessionKey: this.sessionKey,
      sessionId: this.sessionId,
      terminal,
      fitAddon,
    });

    terminal.writeln('\x1b[36mNeonCode\x1b[0m');
    terminal.writeln(`Connecting ${this.sessionId} to ${this.endpoint}`);

    this.configureInputHandlers();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFitAndResize());
    this.resizeObserver.observe(this.container);

    this.connect();
    this.scheduleFitAndResize();
  }

  close() {
    this.resizeObserver?.disconnect();
    this.hubClient?.close();
  }

  configureInputHandlers() {
    const { terminal } = this.state;

    terminal.onData((data) => {
      if (this.shouldSuppressDuplicatePaste(data)) {
        return;
      }
      this.sendTerminalText(data, 'xterm');
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') {
        return true;
      }

      if (event.ctrlKey && !event.altKey && !event.shiftKey && (event.code === 'Space' || event.key === ' ')) {
        console.log(`special_key ${this.index} ctrl_space`);
        this.sendTerminalBytes(new Uint8Array([0]), 'ctrl_space');
        return false;
      }

      if ((event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v')
          || (event.shiftKey && !event.ctrlKey && !event.altKey && event.key === 'Insert')) {
        this.pasteClipboardText('key_paste');
        return false;
      }

      if (event.altKey && !event.ctrlKey && event.key === 'Backspace') {
        console.log(`special_key ${this.index} alt_backspace`);
        this.sendTerminalText('\x1b\x7f', 'alt_backspace');
        return false;
      }

      return true;
    });

    this.container.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain') || clipboard.readText();
      this.pasteText(text, 'dom_paste');
      event.preventDefault();
    });
  }

  sendTerminalBytes(bytes, reason = 'data') {
    if (!bytes || bytes.length === 0) {
      return;
    }

    this.sessionModel.recordInput(this.state);
    console.log(`terminal_input ${this.index} ${bytes.length} ${reason}`);
    this.hubClient?.input(bytes);
  }

  sendTerminalText(text, reason = 'text') {
    this.sendTerminalBytes(encoder.encode(text), reason);
  }

  shouldSuppressDuplicatePaste(data) {
    if (!this.state.suppressedPasteText) {
      return false;
    }

    if (data.includes(this.state.suppressedPasteText)) {
      console.log(`terminal_input_suppressed ${this.index} duplicate_paste`);
      this.state.suppressedPasteText = '';
      return true;
    }

    return false;
  }

  pasteText(text, reason = 'paste') {
    const normalized = normalizeTerminalText(text || '');
    if (!normalized) {
      return;
    }

    console.log(`terminal_paste ${this.index} ${normalized.length} ${reason}`);
    this.state.suppressedPasteText = normalized;
    this.sendTerminalText(normalized, reason);
  }

  pasteClipboardText(reason = 'clipboard') {
    this.pasteText(clipboard.readText(), reason);
  }

  scheduleFitAndResize() {
    if (this.state.resizePending) {
      return;
    }

    this.state.resizePending = true;
    requestAnimationFrame(() => {
      this.state.resizePending = false;
      try {
        this.state.fitAddon.fit();
        const rows = this.state.terminal.rows;
        const cols = this.state.terminal.cols;
        this.sessionModel.updateSize(this.state, { rows, cols });
        if (rows !== this.state.lastRows || cols !== this.state.lastCols) {
          this.state.lastRows = rows;
          this.state.lastCols = cols;
          this.sessionModel.recordResize(this.state);
          console.log(`terminal_resize ${this.index} ${rows} ${cols}`);
        }
        if (this.state.started) {
          this.hubClient?.resize({ rows, cols });
        }
      } catch (error) {
        console.warn('fit failed', error);
      }
    });
  }

  connect() {
    this.hubClient = new HubClient({
      endpoint: this.endpoint,
      sessionId: this.sessionId,
      onOpen: () => this.handleHubOpen(),
      onMessage: (message) => this.handleHubMessage(message),
      onInvalidMessage: (error) => this.handleInvalidHubMessage(error),
      onClose: () => this.handleHubClose(),
      onError: () => this.handleHubError(),
    });
    this.hubClient.connect();
  }

  handleHubOpen() {
    console.log(`hub_connected ${this.index}`);
    this.state.started = true;
    this.setStatus(`Connected to ${this.endpoint}`);
    this.hubClient.start({
      command: 'bash',
      rows: this.state.terminal.rows || 30,
      cols: this.state.terminal.cols || 120,
    });
    this.scheduleFitAndResize();
  }

  handleInvalidHubMessage(error) {
    this.state.terminal.writeln(`\r\n\x1b[31mInvalid hub JSON: ${error.message}\x1b[0m`);
  }

  handleHubMessage(message) {
    if (message.type === 'output' && message.session_id === this.sessionId) {
      this.handleHubOutput(message);
    } else if (message.type === 'started' && message.session_id === this.sessionId) {
      this.handleHubStarted();
    } else if (message.type === 'exit' && message.session_id === this.sessionId) {
      this.state.terminal.writeln('\r\n\x1b[33mHub session exited\x1b[0m');
    } else if (message.type === 'error') {
      this.state.terminal.writeln(`\r\n\x1b[31mHub error: ${message.message}\x1b[0m`);
    }
  }

  handleHubOutput(message) {
    const bytes = base64ToBytes(message.data_b64 || '');
    this.sessionModel.recordOutput(this.state);
    console.log(`hub_output ${this.index} ${bytes.length}`);

    const text = decoder.decode(bytes);
    this.state.outputScanBuffer = (this.state.outputScanBuffer + text).slice(-4096);
    this.scanOutputMarkers();
    this.state.terminal.write(bytes);
  }

  scanOutputMarkers() {
    if (this.state.outputScanBuffer.includes('xtermsmoke')) {
      this.sessionModel.recordSmokeMarker(this.state);
      console.log(`hub_output_marker ${this.index} xtermsmoke`);
    }

    const resizeMatches = [...this.state.outputScanBuffer.matchAll(/xtermresize:([A-Za-z0-9_-]+):(\d+)\s+(\d+)/g)];
    if (resizeMatches.length > 0) {
      const latest = resizeMatches[resizeMatches.length - 1];
      const marker = `${latest[1]} ${latest[2]} ${latest[3]}`;
      if (marker !== this.state.lastResizeMarker) {
        this.state.lastResizeMarker = marker;
        console.log(`hub_output_resize ${this.index} ${latest[1]} ${latest[2]} ${latest[3]}`);
      }
    }

    const checkMatches = [...this.state.outputScanBuffer.matchAll(/xtermcheck:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):([A-Za-z0-9_.-]+)/g)];
    if (checkMatches.length > 0) {
      const latest = checkMatches[checkMatches.length - 1];
      const marker = `${latest[1]} ${latest[2]} ${latest[3]}`;
      if (marker !== this.state.lastCheckMarker) {
        this.state.lastCheckMarker = marker;
        console.log(`hub_output_check ${this.index} ${latest[1]} ${latest[2]} ${latest[3]}`);
      }
    }
  }

  handleHubStarted() {
    console.log(`hub_started ${this.index}`);
    this.sessionModel.setPublicStarted(this.state, true);
    this.state.terminal.writeln('\r\n\x1b[32mHub session started\x1b[0m');
  }

  handleHubClose() {
    console.log(`hub_closed ${this.index}`);
    this.state.started = false;
    this.sessionModel.setPublicStarted(this.state, false);
    this.state.terminal.writeln('\r\n\x1b[33mDisconnected from neoncode-hub\x1b[0m');
    this.setStatus('Disconnected from neoncode-hub');
  }

  handleHubError() {
    console.log(`hub_error ${this.index}`);
    this.state.terminal.writeln('\r\n\x1b[31mWebSocket error. Is ./dev hub running?\x1b[0m');
    this.setStatus('WebSocket error');
  }
}

module.exports = {
  TerminalPane,
  buildTerminalTheme,
  normalizeTerminalText,
};
