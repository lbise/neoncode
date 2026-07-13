const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const { HubClient, base64ToBytes, decoder, encoder } = require('./hub-client');

const CLOSE_ACK_TIMEOUT_MS = 1500;
const LIFECYCLE_LABELS = {
  attached: 'Attached',
  attaching: 'Attaching',
  connecting: 'Connecting',
  detached: 'Detached',
  detaching: 'Detaching',
  disconnected: 'Disconnected',
  error: 'Error',
  exited: 'Exited',
  killed: 'Killed',
  killing: 'Killing',
  started: 'Started',
  starting: 'Starting',
};

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
  constructor({
    index,
    paneId,
    sessionKey,
    sessionId,
    activationMode,
    endpoint,
    container,
    statusElement,
    sessionModel,
    setStatus,
  }) {
    this.index = index;
    this.paneId = paneId;
    this.sessionKey = sessionKey;
    this.sessionId = sessionId;
    this.activationMode = activationMode;
    this.endpoint = endpoint;
    this.container = container;
    this.statusElement = statusElement;
    this.sessionModel = sessionModel;
    this.setStatus = setStatus;
    this.state = undefined;
    this.hubClient = undefined;
    this.resizeObserver = undefined;
    this.activationFallbackUsed = false;
    this.pendingClose = undefined;
    this.closed = false;
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
      activationMode: this.activationMode,
      terminal,
      fitAddon,
    });
    this.setLifecycle('connecting');

    terminal.writeln('\x1b[36mNeonCode\x1b[0m');
    terminal.writeln(`Connecting ${this.sessionId} to ${this.endpoint}`);

    this.configureInputHandlers();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFitAndResize());
    this.resizeObserver.observe(this.container);

    this.connect();
    this.scheduleFitAndResize();
  }

  setLifecycle(lifecycle, error = '') {
    this.sessionModel.setLifecycle(this.state, lifecycle, error);
    if (this.statusElement) {
      this.statusElement.dataset.state = lifecycle;
      this.statusElement.textContent = LIFECYCLE_LABELS[lifecycle] || lifecycle;
      this.statusElement.title = error;
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resizeObserver?.disconnect();
    this.hubClient?.close();
    this.resolvePendingClose();
  }

  detachAndClose() {
    return this.requestClose('detach');
  }

  killAndClose() {
    return this.requestClose('kill');
  }

  requestClose(action) {
    if (this.pendingClose) {
      return this.pendingClose.promise;
    }
    if (this.closed) {
      return Promise.resolve();
    }
    if (!this.hubClient?.isOpen() || ['detached', 'exited', 'killed'].includes(this.state.lifecycle)) {
      this.close();
      return Promise.resolve();
    }

    this.setLifecycle(action === 'detach' ? 'detaching' : 'killing');
    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    const timer = setTimeout(() => {
      this.finishClose('error', `${action} acknowledgement timed out`);
    }, CLOSE_ACK_TIMEOUT_MS);
    this.pendingClose = {
      action,
      promise,
      resolve: resolvePromise,
      timer,
    };

    const sent = action === 'detach' ? this.hubClient.detach() : this.hubClient.kill();
    if (!sent) {
      this.finishClose('error', `failed to send ${action}`);
    }
    return promise;
  }

  finishClose(lifecycle, error = '') {
    this.state.started = false;
    this.sessionModel.setPublicStarted(this.state, false);
    this.setLifecycle(lifecycle, error);
    this.closed = true;
    this.resizeObserver?.disconnect();
    this.hubClient?.close();
    this.resolvePendingClose();
  }

  resolvePendingClose() {
    if (!this.pendingClose) {
      return;
    }
    clearTimeout(this.pendingClose.timer);
    const { resolve } = this.pendingClose;
    this.pendingClose = undefined;
    resolve();
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
      const text = event.clipboardData?.getData('text/plain');
      if (text) {
        this.pasteText(text, 'dom_paste');
      } else {
        this.pasteClipboardText('dom_paste');
      }
      event.preventDefault();
    });
  }

  sendTerminalBytes(bytes, _reason = 'data') {
    if (!bytes || bytes.length === 0 || !this.state.started) {
      return false;
    }

    const sent = this.hubClient?.input(bytes) ?? false;
    if (!sent) {
      return false;
    }

    this.sessionModel.recordInput(this.state);
    return true;
  }

  sendTerminalText(text, reason = 'text') {
    return this.sendTerminalBytes(encoder.encode(text), reason);
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
      return false;
    }

    const sent = this.sendTerminalText(normalized, reason);
    if (sent) {
      this.state.suppressedPasteText = normalized;
    }
    return sent;
  }

  async pasteClipboardText(reason = 'clipboard') {
    try {
      const text = await window.neoncodeDesktop.readClipboardText();
      return this.pasteText(text, reason);
    } catch (error) {
      this.setLifecycle('error', `Clipboard read failed: ${error.message}`);
      return false;
    }
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
    this.setStatus(`Connected to ${this.endpoint}`);
    this.activate(this.activationMode);
  }

  activate(mode) {
    this.activationMode = mode;
    this.sessionModel.setActivationMode(this.state, mode);
    this.setLifecycle(mode === 'attach' ? 'attaching' : 'starting');
    const sent = mode === 'attach'
      ? this.hubClient.attach()
      : this.hubClient.start({
        command: 'bash',
        rows: this.state.terminal.rows || 30,
        cols: this.state.terminal.cols || 120,
      });
    if (!sent) {
      this.handleActivationFailure(`failed to send ${mode}`);
    }
  }

  handleActivationFailure(message) {
    if (!this.activationFallbackUsed) {
      if (this.activationMode === 'attach' && message.includes('unknown session')) {
        this.activationFallbackUsed = true;
        this.activate('start');
        return true;
      }
      if (this.activationMode === 'start' && message.includes('session already exists')) {
        this.activationFallbackUsed = true;
        this.activate('attach');
        return true;
      }
    }
    return false;
  }

  handleInvalidHubMessage(error) {
    this.setLifecycle('error', error.message);
    this.state.terminal.writeln(`\r\n\x1b[31mInvalid hub JSON: ${error.message}\x1b[0m`);
  }

  handleHubMessage(message) {
    if (message.type === 'output' && message.session_id === this.sessionId) {
      this.handleHubOutput(message);
    } else if (message.type === 'started' && message.session_id === this.sessionId) {
      this.handleHubActive('started');
    } else if (message.type === 'attached' && message.session_id === this.sessionId) {
      this.handleHubActive('attached');
    } else if (message.type === 'detached' && message.session_id === this.sessionId) {
      this.finishClose('detached');
    } else if (message.type === 'killed' && message.session_id === this.sessionId) {
      this.finishClose('killed');
    } else if (message.type === 'exit' && message.session_id === this.sessionId) {
      this.state.started = false;
      this.sessionModel.setPublicStarted(this.state, false);
      this.setLifecycle('exited');
      this.state.terminal.writeln(`\r\n\x1b[33mHub session exited (${message.status ?? 'unknown'})\x1b[0m`);
      this.resolvePendingClose();
    } else if (message.type === 'error'
        && (!message.session_id || message.session_id === this.sessionId)) {
      this.handleHubProtocolError(message.message || 'Hub protocol error');
    }
  }

  handleHubActive(lifecycle) {
    this.state.started = true;
    this.sessionModel.setPublicStarted(this.state, true);
    this.setLifecycle(lifecycle);
    console.log(`hub_${lifecycle} ${this.index}`);
    this.state.terminal.writeln(`\r\n\x1b[32mHub session ${lifecycle}\x1b[0m`);
    this.scheduleFitAndResize();
  }

  handleHubProtocolError(message) {
    if (['attaching', 'starting'].includes(this.state.lifecycle)
        && this.handleActivationFailure(message)) {
      return;
    }

    this.setLifecycle('error', message);
    this.state.terminal.writeln(`\r\n\x1b[31mHub error: ${message}\x1b[0m`);
    this.setStatus(`Hub error: ${message}`);
    if (this.pendingClose) {
      this.finishClose('error', message);
    }
  }

  handleHubOutput(message) {
    const bytes = base64ToBytes(message.data_b64 || '');
    const text = decoder.decode(bytes);
    if (this.sessionModel.recordOutput(this.state, text, message.seq)) {
      this.state.terminal.write(bytes);
    }
  }

  handleHubClose() {
    this.state.started = false;
    this.sessionModel.setPublicStarted(this.state, false);
    if (this.pendingClose) {
      this.closed = true;
      this.setLifecycle('error', 'WebSocket closed before session acknowledgement');
      this.resolvePendingClose();
      return;
    }
    if (this.closed || ['detached', 'killed'].includes(this.state.lifecycle)) {
      return;
    }

    console.log(`hub_closed ${this.index}`);
    this.setLifecycle('disconnected');
    this.state.terminal.writeln('\r\n\x1b[33mDisconnected from neoncode-hub\x1b[0m');
    this.setStatus('Disconnected from neoncode-hub');
  }

  handleHubError() {
    if (this.closed) {
      return;
    }
    console.log(`hub_error ${this.index}`);
    this.setLifecycle('error', 'WebSocket error');
    this.state.terminal.writeln('\r\n\x1b[31mWebSocket error. Is ./dev hub running?\x1b[0m');
    this.setStatus('WebSocket error');
  }
}

module.exports = {
  CLOSE_ACK_TIMEOUT_MS,
  TerminalPane,
  buildTerminalTheme,
  normalizeTerminalText,
};
