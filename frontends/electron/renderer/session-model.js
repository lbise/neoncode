const MAX_RECENT_OUTPUT_CHARS = 32768;

class SessionModel {
  constructor({ windowRef = window } = {}) {
    this.windowRef = windowRef;
    this.publicState = {
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
      inputEvents: 0,
      resizeEvents: 0,
      lastRows: terminal.rows,
      lastCols: terminal.cols,
      suppressedPasteText: '',
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
      inputEvents: 0,
      resizeEvents: 0,
      recentOutput: '',
      rows: terminal.rows,
      cols: terminal.cols,
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

  recordInput(state) {
    state.inputEvents += 1;
    this.pane(state).inputEvents = state.inputEvents;
  }

  recordOutput(state, text) {
    state.outputEvents += 1;
    const pane = this.pane(state);
    pane.outputEvents = state.outputEvents;
    pane.recentOutput = (pane.recentOutput + text).slice(-MAX_RECENT_OUTPUT_CHARS);
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
