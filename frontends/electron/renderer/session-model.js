class SessionModel {
  constructor({ windowRef = window } = {}) {
    this.windowRef = windowRef;
    this.publicState = { panes: [] };
    this.windowRef.neoncodeXtermState = this.publicState;
  }

  createPaneState({ index, sessionId, terminal, fitAddon }) {
    const state = {
      index,
      sessionId,
      terminal,
      fitAddon,
      started: false,
      resizePending: false,
      outputEvents: 0,
      inputEvents: 0,
      resizeEvents: 0,
      smokeMarkerCount: 0,
      lastRows: terminal.rows,
      lastCols: terminal.cols,
      outputScanBuffer: '',
      lastResizeMarker: '',
      lastCheckMarker: '',
      suppressedPasteText: '',
    };

    this.publicState.panes[index] = {
      sessionId,
      started: false,
      outputEvents: 0,
      inputEvents: 0,
      resizeEvents: 0,
      lastSmokeMarkerCount: 0,
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

  updateSize(state, { rows, cols }) {
    const pane = this.pane(state);
    pane.rows = rows;
    pane.cols = cols;
  }

  recordInput(state) {
    state.inputEvents += 1;
    this.pane(state).inputEvents = state.inputEvents;
  }

  recordOutput(state) {
    state.outputEvents += 1;
    this.pane(state).outputEvents = state.outputEvents;
  }

  recordResize(state) {
    state.resizeEvents += 1;
    this.pane(state).resizeEvents = state.resizeEvents;
  }

  recordSmokeMarker(state) {
    state.smokeMarkerCount += 1;
    this.pane(state).lastSmokeMarkerCount = state.smokeMarkerCount;
  }
}

module.exports = {
  SessionModel,
};
