const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const {
  HubClient,
  base64ToBytes,
  decoder,
  encoder,
  parseReplayCheckpoint,
} = require('./hub-client');
const {
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  ReconnectPolicy,
  activationFallback,
} = require('./reconnect-policy');

const CLOSE_ACK_TIMEOUT_MS = 1500;
const LIFECYCLE_LABELS = {
  attached: 'Attached',
  attaching: 'Attaching',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
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

function buildTerminalTheme(appearance) {
  const theme = appearance.theme;
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursorColor,
    selectionBackground: theme.selectionBackground,
    black: theme.black,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.purple,
    cyan: theme.cyan,
    white: theme.white,
    brightBlack: theme.brightBlack,
    brightRed: theme.brightRed,
    brightGreen: theme.brightGreen,
    brightYellow: theme.brightYellow,
    brightBlue: theme.brightBlue,
    brightMagenta: theme.brightPurple,
    brightCyan: theme.brightCyan,
    brightWhite: theme.brightWhite,
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
    capabilityToken,
    launchProfile,
    terminalAppearance,
    container,
    statusElement,
    sessionModel,
    setStatus,
    onLifecycleChange,
    onSessionExit,
    hubClientFactory = (options) => new HubClient(options),
    reconnectPolicy = new ReconnectPolicy(),
  }) {
    this.index = index;
    this.paneId = paneId;
    this.sessionKey = sessionKey;
    this.sessionId = sessionId;
    this.activationMode = activationMode;
    this.endpoint = endpoint;
    this.capabilityToken = capabilityToken;
    this.launchProfile = launchProfile;
    this.terminalAppearance = terminalAppearance;
    this.container = container;
    this.statusElement = statusElement;
    this.sessionModel = sessionModel;
    this.setStatus = setStatus;
    this.onLifecycleChange = onLifecycleChange;
    this.onSessionExit = onSessionExit;
    this.hubClientFactory = hubClientFactory;
    this.state = undefined;
    this.hubClient = undefined;
    this.resizeObserver = undefined;
    this.activationFallbackUsed = false;
    this.pendingClose = undefined;
    this.closed = false;
    this.connectionGeneration = 0;
    this.reconnectPolicy = reconnectPolicy;
    this.pasteShortcutActive = false;
    this.pasteShortcutTimer = undefined;
    this.suppressedPasteTimer = undefined;
    this.supportsExitAttention = false;
    this.disposed = false;
  }

  start() {
    const terminal = new Terminal({
      cursorBlink: this.terminalAppearance.cursorBlink,
      convertEol: false,
      fontFamily: this.terminalAppearance.fontFamily,
      fontSize: this.terminalAppearance.fontSize,
      scrollback: 10000,
      theme: buildTerminalTheme(this.terminalAppearance),
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
    this.onLifecycleChange?.(lifecycle, error);
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connectionGeneration += 1;
    this.reconnectPolicy.cancel();
    clearTimeout(this.pasteShortcutTimer);
    clearTimeout(this.suppressedPasteTimer);
    this.resizeObserver?.disconnect();
    this.hubClient?.close();
    this.resolvePendingClose();
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.close();
    this.state?.terminal.dispose();
    this.container.replaceChildren();
  }

  detachAndClose() {
    return this.requestClose('detach');
  }

  killAndClose() {
    return this.requestClose('kill');
  }

  requestClose(action) {
    this.reconnectPolicy.cancel();
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
    this.connectionGeneration += 1;
    clearTimeout(this.pasteShortcutTimer);
    clearTimeout(this.suppressedPasteTimer);
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

      if ((event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c')
          || (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === 'Insert')) {
        this.copySelection();
        return false;
      }

      if ((event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v')
          || (event.shiftKey && !event.ctrlKey && !event.altKey && event.key === 'Insert')) {
        this.handlePasteShortcut();
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
      if (this.pasteShortcutActive) {
        console.log(`terminal_input_suppressed ${this.index} duplicate_dom_paste`);
        event.preventDefault();
        return;
      }
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

  handlePasteShortcut() {
    if (this.pasteShortcutActive) {
      return;
    }
    this.pasteShortcutActive = true;
    clearTimeout(this.pasteShortcutTimer);
    this.pasteClipboardText('key_paste').finally(() => {
      this.pasteShortcutTimer = setTimeout(() => {
        this.pasteShortcutActive = false;
      }, 150);
    });
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
      clearTimeout(this.suppressedPasteTimer);
      this.suppressedPasteTimer = setTimeout(() => {
        this.state.suppressedPasteText = '';
      }, 250);
    }
    return sent;
  }

  async copySelection() {
    const text = this.state.terminal.getSelection();
    if (!text) {
      return false;
    }
    try {
      await window.neoncodeDesktop.writeClipboardText(text);
      return !this.disposed;
    } catch (error) {
      if (!this.disposed) {
        this.setLifecycle('error', `Clipboard write failed: ${error.message}`);
      }
      return false;
    }
  }

  async pasteClipboardText(reason = 'clipboard') {
    try {
      const text = await window.neoncodeDesktop.readClipboardText();
      return this.disposed ? false : this.pasteText(text, reason);
    } catch (error) {
      if (!this.disposed) {
        this.setLifecycle('error', `Clipboard read failed: ${error.message}`);
      }
      return false;
    }
  }

  scheduleFitAndResize() {
    if (this.state.resizePending) {
      return;
    }

    this.state.resizePending = true;
    requestAnimationFrame(() => {
      if (this.disposed) {
        return;
      }
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
    const generation = ++this.connectionGeneration;
    this.hubClient = this.hubClientFactory({
      endpoint: this.endpoint,
      capabilityToken: this.capabilityToken,
      sessionId: this.sessionId,
      onOpen: (welcome) => generation === this.connectionGeneration && this.handleHubOpen(welcome),
      onMessage: (message) => generation === this.connectionGeneration && this.handleHubMessage(message),
      onInvalidMessage: (error) => generation === this.connectionGeneration && this.handleInvalidHubMessage(error),
      onClose: () => generation === this.connectionGeneration && this.handleHubClose(),
      onError: () => generation === this.connectionGeneration && this.handleHubError(),
    });
    this.hubClient.connect();
  }

  handleHubOpen(welcome) {
    console.log(`hub_connected ${this.index}`);
    this.supportsExitAttention = welcome.capabilities.includes('session_exit_attention');
    this.sessionModel.beginHubBoot(this.state, welcome.boot_id);
    this.setStatus(`Connected to ${this.endpoint}`);
    const recovering = this.reconnectPolicy.attempts > 0;
    this.activationFallbackUsed = false;
    this.activate(recovering ? 'attach' : this.activationMode);
  }

  activate(mode) {
    this.activationMode = mode;
    this.sessionModel.setActivationMode(this.state, mode);
    this.setLifecycle(mode === 'attach' ? 'attaching' : 'starting');
    const replayCursor = this.state.sessionInstanceId
      ? {
        instanceId: this.state.sessionInstanceId,
        afterOutputSeq: this.state.lastOutputSeq,
      }
      : undefined;
    const sent = mode === 'attach'
      ? this.hubClient.attach(replayCursor)
      : this.hubClient.start({
        command: this.launchProfile.command,
        args: this.launchProfile.args,
        cwd: this.launchProfile.cwd,
        persistent: true,
        rows: this.state.terminal.rows || 30,
        cols: this.state.terminal.cols || 120,
      });
    if (!sent) {
      this.handleActivationFailure(`failed to send ${mode}`);
    }
  }

  handleActivationFailure(message) {
    const fallback = activationFallback({
      mode: this.activationMode,
      message,
      alreadyUsed: this.activationFallbackUsed,
    });
    if (!fallback) return false;
    this.activationFallbackUsed = true;
    this.activate(fallback);
    return true;
  }

  handleInvalidHubMessage(error) {
    this.setLifecycle('error', error.message);
    this.state.terminal.writeln(`\r\n\x1b[31mInvalid hub JSON: ${error.message}\x1b[0m`);
  }

  handleHubMessage(message) {
    if (message.type === 'output' && message.session_id === this.sessionId) {
      this.handleHubOutput(message);
    } else if (message.type === 'started' && message.session_id === this.sessionId) {
      if (Object.hasOwn(message, 'instance_id') && !/^[0-9a-f]{32}$/.test(message.instance_id)) {
        this.handleInvalidHubMessage(new Error('Invalid started session instance'));
        this.hubClient?.close();
        return;
      }
      const instanceChanged = /^[0-9a-f]{32}$/.test(message.instance_id || '')
        && this.state.sessionInstanceId
        && this.state.sessionInstanceId !== message.instance_id;
      if (instanceChanged) {
        this.state.terminal.reset();
        this.state.terminal.writeln('\x1b[33mReplacement session started; terminal replay reset\x1b[0m');
        this.sessionModel.applyReplayCheckpoint(this.state, {
          instanceId: message.instance_id,
          firstAvailableSeq: 1,
          replayThroughSeq: 0,
          replayTruncated: false,
          resetRequired: true,
        });
      } else {
        this.sessionModel.setSessionInstance(this.state, message.instance_id);
      }
      this.handleHubActive('started');
    } else if (message.type === 'attached' && message.session_id === this.sessionId) {
      let checkpoint;
      try {
        checkpoint = parseReplayCheckpoint(message);
      } catch (error) {
        this.handleInvalidHubMessage(error);
        this.hubClient?.close();
        return;
      }
      if (checkpoint) {
        if (checkpoint.resetRequired) {
          this.state.terminal.reset();
          this.state.terminal.writeln('\x1b[33mSession incarnation changed; terminal replay reset\x1b[0m');
        }
        this.sessionModel.applyReplayCheckpoint(this.state, checkpoint);
        if (checkpoint.replayTruncated
            || (checkpoint.resetRequired && checkpoint.firstAvailableSeq > 1)) {
          this.state.terminal.writeln(
            `\x1b[33mReplay truncated before output sequence ${checkpoint.firstAvailableSeq}\x1b[0m`,
          );
        }
      }
      this.handleHubActive('attached');
    } else if (message.type === 'detached' && message.session_id === this.sessionId) {
      this.finishClose('detached');
    } else if (message.type === 'killed' && message.session_id === this.sessionId) {
      this.finishClose('killed');
    } else if (message.type === 'exit' && message.session_id === this.sessionId) {
      const outcome = {
        attentionId: typeof message.attention_id === 'string' && /^[0-9a-f]{32}$/.test(message.attention_id)
          ? message.attention_id
          : null,
        status: Number.isInteger(message.status) ? message.status : null,
        reason: ['process_exit', 'wait_failed', 'killed'].includes(message.reason)
          ? message.reason
          : 'process_exit',
      };
      this.state.started = false;
      this.sessionModel.setPublicStarted(this.state, false);
      this.sessionModel.recordExit(this.state, outcome);
      if (this.supportsExitAttention && outcome.attentionId && outcome.reason !== 'killed') {
        this.onSessionExit?.(outcome);
      }
      this.setLifecycle(outcome.reason === 'killed' ? 'killed' : 'exited');
      const status = outcome.status ?? 'unknown';
      const reason = outcome.reason.replaceAll('_', ' ');
      if (this.statusElement) {
        this.statusElement.textContent = outcome.reason === 'killed' ? 'Killed' : `Exited (${status})`;
      }
      this.state.terminal.writeln(`\r\n\x1b[33mHub session exited (${status}, ${reason})\x1b[0m`);
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
    this.reconnectPolicy.reset();
    this.sessionModel.clearReconnect(this.state);
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
    this.state.terminal.writeln('\r\n\x1b[33mDisconnected from neoncode-hub; reconnecting\x1b[0m');
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closed || this.pendingClose) return;
    const scheduled = this.reconnectPolicy.schedule(() => {
      if (!this.closed && !this.pendingClose) {
        this.connect();
      }
    });
    if (!scheduled) return;
    this.setLifecycle('reconnecting');
    this.setStatus(`Reconnecting to neoncode-hub in ${scheduled.delayMs}ms`);
    this.sessionModel.recordReconnect(this.state, scheduled.attempts, scheduled.delayMs);
  }

  forceDisconnectForTest() {
    this.hubClient?.close();
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
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  TerminalPane,
  buildTerminalTheme,
  normalizeTerminalText,
};
