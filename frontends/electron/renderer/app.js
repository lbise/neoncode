const { SessionModel } = require('./session-model');
const { TerminalPane } = require('./terminal-pane');

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:44777/ws';
const DEFAULT_TERMINAL_COUNT = 2;
const DEFAULT_SESSION_PREFIX = 'electron-xterm-shell';
const MAX_STATIC_TERMINAL_PANES = 2;

function parseTerminalCount(value) {
  return Number.parseInt(value || String(DEFAULT_TERMINAL_COUNT), 10) || DEFAULT_TERMINAL_COUNT;
}

function createAppConfig(env = process.env) {
  return {
    endpoint: env.NEONCODE_HUB_ENDPOINT || DEFAULT_ENDPOINT,
    terminalCount: parseTerminalCount(env.NEONCODE_TERMINAL_COUNT),
    sessionPrefix: env.NEONCODE_SESSION_PREFIX || DEFAULT_SESSION_PREFIX,
  };
}

class NeonCodeApp {
  constructor({ documentRef = document, windowRef = window, env = process.env } = {}) {
    this.document = documentRef;
    this.window = windowRef;
    this.config = createAppConfig(env);
    this.statusElement = this.document.getElementById('status');
    this.terminalGrid = this.document.getElementById('terminal-grid');
    this.sessionModel = new SessionModel({ windowRef: this.window });
    this.panes = [];
  }

  setStatus(text) {
    this.statusElement.textContent = text;
  }

  configureGrid() {
    const count = Math.max(1, this.config.terminalCount);
    this.terminalGrid.style.gridTemplateColumns = `repeat(${count}, minmax(0, 1fr))`;

    for (let index = 0; index < MAX_STATIC_TERMINAL_PANES; index += 1) {
      const pane = this.document.getElementById(`terminal-${index + 1}`)?.parentElement;
      if (pane) {
        pane.style.display = index < count ? 'grid' : 'none';
      }
    }
  }

  start() {
    this.configureGrid();
    const count = Math.min(MAX_STATIC_TERMINAL_PANES, Math.max(1, this.config.terminalCount));
    for (let index = 0; index < count; index += 1) {
      this.createPane(index);
    }
  }

  createPane(index) {
    const sessionId = `${this.config.sessionPrefix}-${index + 1}`;
    const container = this.document.getElementById(`terminal-${index + 1}`);
    if (!container) {
      return;
    }

    const pane = new TerminalPane({
      index,
      sessionId,
      endpoint: this.config.endpoint,
      container,
      sessionModel: this.sessionModel,
      setStatus: (text) => this.setStatus(text),
    });
    this.panes.push(pane);
    pane.start();
  }

  close() {
    for (const pane of this.panes) {
      pane.close();
    }
  }
}

function startRendererApp() {
  const app = new NeonCodeApp();
  window.addEventListener('DOMContentLoaded', () => {
    app.start();
  });
  window.addEventListener('beforeunload', () => {
    app.close();
  });
  return app;
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_SESSION_PREFIX,
  DEFAULT_TERMINAL_COUNT,
  NeonCodeApp,
  createAppConfig,
  parseTerminalCount,
  startRendererApp,
};
