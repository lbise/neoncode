const MAX_RECENT_OUTPUT_CHARS = 32768;

class SessionModel {
  constructor({ windowRef = window } = {}) {
    this.windowRef = windowRef;
    this.publicState = {
      configuration: {
        valid: false,
        configStatus: 'idle',
        stateStatus: 'idle',
        warnings: [],
        errors: [],
        persistencePolicy: 'detach',
        sessions: [],
      },
      panes: [],
      sessionDiscovery: {
        status: 'idle',
        sessionListEvents: 0,
        sessions: [],
        error: '',
      },
    };
    this.windowRef.neoncodeXtermState = this.publicState;
  }

  setConfiguration(configuration) {
    this.publicState.configuration = JSON.parse(JSON.stringify(configuration));
  }

  setSessionDiscoveryStatus(status, error = '') {
    this.publicState.sessionDiscovery.status = status;
    this.publicState.sessionDiscovery.error = error;
  }

  recordSessionList(sessions) {
    this.publicState.sessionDiscovery.status = 'ready';
    this.publicState.sessionDiscovery.sessionListEvents += 1;
    this.publicState.sessionDiscovery.sessions = sessions;
    this.publicState.sessionDiscovery.error = '';
  }

  createPaneState({ index, paneId, sessionKey, sessionId, activationMode, terminal, fitAddon }) {
    const state = {
      index,
      paneId,
      sessionKey,
      sessionId,
      activationMode,
      lifecycle: 'connecting',
      error: '',
      terminal,
      fitAddon,
      started: false,
      resizePending: false,
      outputEvents: 0,
      firstOutputSeq: 0,
      lastOutputSeq: 0,
      inputEvents: 0,
      resizeEvents: 0,
      lastRows: terminal.rows,
      lastCols: terminal.cols,
      suppressedPasteText: '',
      hubBootId: '',
      reconnectAttempts: 0,
      reconnectEvents: 0,
    };

    this.publicState.panes[index] = {
      paneId,
      sessionKey,
      sessionId,
      activationMode,
      lifecycle: 'connecting',
      error: '',
      started: false,
      outputEvents: 0,
      firstOutputSeq: 0,
      lastOutputSeq: 0,
      outputGap: '',
      inputEvents: 0,
      resizeEvents: 0,
      recentOutput: '',
      rows: terminal.rows,
      cols: terminal.cols,
      hubBootId: '',
      reconnectAttempts: 0,
      reconnectEvents: 0,
      reconnectDelayMs: 0,
    };

    return state;
  }

  pane(state) {
    return this.publicState.panes[state.index];
  }

  setPublicStarted(state, started) {
    this.pane(state).started = started;
  }

  setActivationMode(state, activationMode) {
    state.activationMode = activationMode;
    this.pane(state).activationMode = activationMode;
  }

  setLifecycle(state, lifecycle, error = '') {
    state.lifecycle = lifecycle;
    state.error = error;
    const pane = this.pane(state);
    pane.lifecycle = lifecycle;
    pane.error = error;
  }

  updateSize(state, { rows, cols }) {
    const pane = this.pane(state);
    pane.rows = rows;
    pane.cols = cols;
  }

  beginHubBoot(state, bootId) {
    if (state.hubBootId && state.hubBootId !== bootId) {
      state.firstOutputSeq = 0;
      state.lastOutputSeq = 0;
      const pane = this.pane(state);
      pane.firstOutputSeq = 0;
      pane.lastOutputSeq = 0;
      pane.outputGap = '';
    }
    state.hubBootId = bootId;
    this.pane(state).hubBootId = bootId;
  }

  recordReconnect(state, attempts, delayMs) {
    state.reconnectAttempts = attempts;
    state.reconnectEvents += 1;
    const pane = this.pane(state);
    pane.reconnectAttempts = attempts;
    pane.reconnectEvents = state.reconnectEvents;
    pane.reconnectDelayMs = delayMs;
  }

  clearReconnect(state) {
    state.reconnectAttempts = 0;
    const pane = this.pane(state);
    pane.reconnectAttempts = 0;
    pane.reconnectDelayMs = 0;
  }

  recordInput(state) {
    state.inputEvents += 1;
    this.pane(state).inputEvents = state.inputEvents;
  }

  recordOutput(state, text, seq) {
    const outputSeq = Number.isSafeInteger(seq) ? seq : state.lastOutputSeq + 1;
    if (outputSeq <= state.lastOutputSeq) {
      return false;
    }

    const pane = this.pane(state);
    if (state.lastOutputSeq > 0 && outputSeq !== state.lastOutputSeq + 1) {
      pane.outputGap = `${state.lastOutputSeq + 1}-${outputSeq - 1}`;
    }
    if (state.firstOutputSeq === 0) {
      state.firstOutputSeq = outputSeq;
      pane.firstOutputSeq = outputSeq;
    }
    state.lastOutputSeq = outputSeq;
    pane.lastOutputSeq = outputSeq;
    state.outputEvents += 1;
    pane.outputEvents = state.outputEvents;
    pane.recentOutput = (pane.recentOutput + text).slice(-MAX_RECENT_OUTPUT_CHARS);
    return true;
  }

  recordResize(state) {
    state.resizeEvents += 1;
    this.pane(state).resizeEvents = state.resizeEvents;
  }
}

module.exports = {
  MAX_RECENT_OUTPUT_CHARS,
  SessionModel,
};
